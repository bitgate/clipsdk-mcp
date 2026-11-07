import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { ApiError, type ClipSdk, type UploadTicket } from "./api.js";
import type { ToolContext } from "./context.js";
import { log } from "./log.js";
import { hasHiddenSegment, isNetworkPath, LinkError, resolveLinks } from "./paths.js";
import { ToolError } from "./results.js";
import { HEAD_BYTES, videoContainer, type Container } from "./sniff.js";
import { resolvePath, type Workspace } from "./workspace.js";

// clipsdk counts in decimal gigabytes
export const MAX_UPLOAD_BYTES = 5_000_000_000;

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const HTTP_URL = /^https?:\/\//i;
const OTHER_URL = /^[a-z][a-z0-9+.-]+:\/\//i;
const PRIVATE_HOST = /^(localhost|.+\.localhost|.+\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;
const UPLOAD_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv"]);

// clipsdk keeps an upload 7 days, and we reuse one until a day before it goes
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const REUSE_MARGIN_MS = 24 * 60 * 60 * 1000;
const PROGRESS_EVERY_MS = 5000;

// A page on these sites is a player, not the video; clipsdk refuses them unless the path names a video file
const PAGE_SITES = new Map<string, string>([
  ["youtube.com", "YouTube"],
  ["youtu.be", "YouTube"],
  ["youtube-nocookie.com", "YouTube"],
  ["tiktok.com", "TikTok"],
  ["instagram.com", "Instagram"],
  ["vimeo.com", "Vimeo"],
  ["x.com", "X"],
  ["twitter.com", "X"],
  ["facebook.com", "Facebook"],
  ["fb.watch", "Facebook"],
  ["twitch.tv", "Twitch"],
  ["rumble.com", "Rumble"],
  ["dailymotion.com", "Dailymotion"],
  ["dai.ly", "Dailymotion"],
  ["loom.com", "Loom"],
]);
const MEDIA_PATH = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g)$/i;

export interface LocalFile {
  path: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  container: Container;
}

export class StillUploading extends Error {
  constructor(
    readonly file: string,
    readonly sent: number,
    readonly size: number,
  ) {
    super(`Still uploading ${file}`);
    this.name = "StillUploading";
  }
}

class Transfer {
  sent = 0;
  waiting = 0;
  keepUntil: number | undefined;
  readonly controller = new AbortController();
  readonly done: Promise<UploadTicket>;

  constructor(
    readonly file: LocalFile,
    send: (transfer: Transfer) => Promise<UploadTicket>,
  ) {
    this.done = send(this).then((ticket) => {
      this.keepUntil = Date.now() + KEPT_MS;
      return ticket;
    });
  }
}

export class Media {
  readonly #transfers = new Map<string, Transfer>();

  constructor(
    private readonly api: ClipSdk,
    private readonly workspace: Workspace,
    private readonly waitSeconds: number,
  ) {}

  async toUrl(input: string, ctx: ToolContext): Promise<string> {
    const value = input.trim();
    if (HTTP_URL.test(value)) return videoLink(value);
    if (OTHER_URL.test(value) && !/^file:\/\//i.test(value)) {
      throw new ToolError(`Can't use "${value}": pass a local file path or a direct http(s) link to the video file.`);
    }

    return (await this.upload(await this.localFile(value), ctx)).video_url;
  }

  // Whatever the path, only a regular video file on this machine outside hidden folders gets uploaded
  async localFile(input: string): Promise<LocalFile> {
    const value = input.trim();
    if (isNetworkPath(value)) throw new ToolError(`${value} is on another machine. Pass a file on this computer or a direct http(s) link to the video.`);

    const baseDir = await this.workspace.baseDir();
    const filePath = resolvePath(value, baseDir);
    if (hasHiddenSegment(filePath, baseDir)) throw hiddenFile(filePath);

    const unreadable = (error: NodeJS.ErrnoException): never => {
      if (error instanceof LinkError) throw new ToolError(`Can't upload ${filePath}: ${error.message}.`);
      if (error.code === "ENOENT") {
        throw new ToolError(`File not found: ${filePath}. Relative paths resolve against ${baseDir}; pass an absolute path or a direct http(s) link.`);
      }
      throw new ToolError(`Can't read ${filePath}: ${error.message}`);
    };
    const realPath = await resolveLinks(filePath).catch(unreadable);
    if (hasHiddenSegment(realPath, await realpath(baseDir).catch(() => baseDir))) throw hiddenFile(filePath);

    // lstat, so the identity we check later is never that of a file a link leads to
    const stats = await lstat(realPath).catch(unreadable);
    if (stats.isSymbolicLink()) throw changed(filePath);
    if (!stats.isFile()) throw new ToolError(`${filePath} is not a file.`);
    if (stats.size === 0) throw new ToolError(`${filePath} is empty.`);
    if (stats.size > MAX_UPLOAD_BYTES) {
      throw new ToolError(`${filePath} is ${gigabytes(stats.size)}, over clipsdk's 5 GB limit for a video. Re-encode it at a lower bitrate or cut it into parts first.`);
    }

    const identity = { path: filePath, realPath, size: stats.size, mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino };
    const handle = await openUnchanged(identity);
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
      const container = videoContainer(buffer.subarray(0, bytesRead), stats.size);
      if (!container) {
        throw new ToolError(
          `${filePath} doesn't look like an MP4, MOV, WebM or MKV video, so it isn't uploaded. Convert it first, e.g. ffmpeg -i "${path.basename(filePath)}" -c:v libx264 -c:a aac out.mp4`,
        );
      }
      return { ...identity, container };
    } finally {
      await handle.close();
    }
  }

  // One upload per file, shared by every call that needs it and reused for as long as clipsdk keeps it. It runs on its own,
  // so a call that runs out of time leaves it going for the next one, and a cancelled call stops it only when nobody else waits
  async upload(file: LocalFile, ctx: ToolContext): Promise<UploadTicket> {
    const key = [file.realPath, file.dev, file.ino, file.size, file.mtimeMs].join("|");
    const known = this.#transfers.get(key);
    const transfer = known && (known.keepUntil === undefined || known.keepUntil - Date.now() > REUSE_MARGIN_MS) ? known : this.#start(file, key);
    return transfer.keepUntil === undefined ? this.#waitFor(transfer, ctx) : transfer.done;
  }

  #start(file: LocalFile, key: string): Transfer {
    const transfer = new Transfer(file, (started) => this.#send(started));
    this.#transfers.set(key, transfer);
    transfer.done.catch((error: unknown) => {
      if (this.#transfers.get(key) === transfer) this.#transfers.delete(key);
      log(`upload of ${file.path} stopped`, error);
    });
    return transfer;
  }

  async #waitFor(transfer: Transfer, ctx: ToolContext): Promise<UploadTicket> {
    const { file } = transfer;
    const report = () => ctx.progress(`uploading ${path.basename(file.path)}: ${megabytes(transfer.sent)} of ${megabytes(file.size)}`);
    report();

    const deadline = ctx.startedAt + this.waitSeconds * 1000;
    const ticker = setInterval(report, PROGRESS_EVERY_MS);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    transfer.waiting += 1;
    try {
      return await new Promise<UploadTicket>((resolve, reject) => {
        transfer.done.then(resolve, reject);
        timer = setTimeout(() => reject(new StillUploading(file.path, transfer.sent, file.size)), Math.max(0, deadline - Date.now()));
        onAbort = () => reject(ctx.signal.reason);
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      transfer.waiting -= 1;
      clearInterval(ticker);
      clearTimeout(timer);
      if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
      if (ctx.signal.aborted && transfer.waiting === 0 && transfer.keepUntil === undefined) transfer.controller.abort(ctx.signal.reason);
    }
  }

  // A ticket's URL works for an hour, so an upload that outlives it gets one more ticket
  async #send(transfer: Transfer): Promise<UploadTicket> {
    const { file, controller } = transfer;
    const handle = await openUnchanged(file);
    try {
      for (let tickets = 1; ; tickets++) {
        const ticket = await this.api.createUpload(uploadName(file), file.size, controller.signal);
        try {
          await this.api.putUpload(ticket, { handle, size: file.size }, controller.signal, (sent) => (transfer.sent = sent));
        } catch (error) {
          if (tickets === 1 && error instanceof ApiError && error.code === "UPLOAD_EXPIRED") continue;
          throw error;
        }

        const now = await handle.stat();
        if (now.size !== file.size || now.mtimeMs !== file.mtimeMs) throw new ToolError(`${file.path} changed while it was being uploaded; try again once it's done changing.`);
        log(`uploaded ${file.path} (${file.size} bytes)`);
        return ticket;
      }
    } finally {
      await handle.close();
    }
  }
}

// We open what we checked, without following a link where the system can refuse one (Windows can't), and refuse it when
// another file took its place: by identity, and by path, since a parent folder swapped for a link fools lstat and open alike
async function openUnchanged(file: Omit<LocalFile, "container">): Promise<FileHandle> {
  const handle = await open(file.realPath, OPEN_FLAGS);
  const now = await handle.stat();
  const samePath = await realpath(file.realPath).then((real) => real === file.realPath, () => false);
  if (samePath && now.isFile() && now.dev === file.dev && now.ino === file.ino && now.size === file.size && now.mtimeMs === file.mtimeMs) return handle;

  await handle.close();
  throw changed(file.path);
}

// clipsdk keeps the letters, digits, dots, dashes and underscores of a name, and wants one of its four extensions at the end
function uploadName(file: LocalFile): string {
  const stem = path
    .parse(file.path)
    .name.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 48);
  const extension = path.extname(file.path).toLowerCase();
  return `${stem || "video"}${UPLOAD_EXTENSIONS.has(extension) ? extension : `.${file.container}`}`;
}

function changed(filePath: string): ToolError {
  return new ToolError(`${filePath} changed while it was being checked; try again.`);
}

function hiddenFile(filePath: string): ToolError {
  return new ToolError(`${filePath} is hidden or inside a hidden folder, and those are never uploaded.`);
}

// clipsdk fetches one file over the internet: a page link, a private host, another port or a user:pass@ never works
function videoLink(value: string): string {
  if (!URL.canParse(value)) throw new ToolError(`"${value}" is not a valid URL.`);

  const url = new URL(value);
  const local = "Pass the local file path instead; it gets uploaded.";
  if (url.username || url.password) throw new ToolError(`clipsdk doesn't take links with a user name or password in them. ${local}`);
  if (PRIVATE_HOST.test(url.hostname)) throw new ToolError(`clipsdk downloads links over the internet and can't reach ${url.hostname}. ${local}`);
  if (url.port) throw new ToolError(`clipsdk only fetches links on the scheme's own port, and ${url.host} isn't. ${local}`);

  const site = pageSite(url);
  if (site) {
    throw new ToolError(`${site} links are web pages, not video files, and clipsdk doesn't download them. Pass a direct link to the video file, or the local file path (it gets uploaded).`);
  }
  return value;
}

function pageSite({ hostname, pathname }: URL): string | undefined {
  if (MEDIA_PATH.test(pathname)) return undefined;

  const labels = hostname.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const site = PAGE_SITES.get(labels.slice(i).join("."));
    if (site) return site;
  }
  return undefined;
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}
