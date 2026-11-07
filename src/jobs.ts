import { mkdir, open, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { displayUrl, type Clip, type ClipSdk, type ClipsRequest, type Job } from "./api.js";
import type { Config } from "./config.js";
import { elapsedSeconds, type FileKind, type SavedFile, type SavedJob, type ToolContext } from "./context.js";
import { errorMessage, log } from "./log.js";
import { discard, isDeviceName, isInside, placeIn, realDir } from "./paths.js";
import { failedResult, fileError, jobAge, linksResult, runningResult, savedResult } from "./results.js";
import { resolvePath, type Workspace } from "./workspace.js";

const POLL_WAIT_S = 10;
const PARALLEL_DOWNLOADS = 4;
const MAX_NAME = 64;
const CAPTIONS = "captions";
const EXTENSIONS: Record<FileKind, string> = { video: ".mp4", poster: ".jpg", srt: ".srt", vtt: ".vtt" };

interface Tracked {
  stem?: string;
  job?: Job;
  save?: SharedSave;
}

interface SharedSave {
  saved: Promise<SavedJob>;
  stop: AbortController;
  waiting: number;
}

export interface PlannedFile {
  clip: number;
  kind: FileKind;
  url: string;
  name: string;
}

export class JobRunner {
  readonly #tracked = new Map<string, Tracked>();

  constructor(
    private readonly api: ClipSdk,
    private readonly config: Config,
    private readonly workspace: Workspace,
  ) {}

  async start(request: ClipsRequest, stem: string | undefined, save: boolean, ctx: ToolContext): Promise<CallToolResult> {
    const job = await this.api.createClips(request, ctx.signal);
    log(`clips job ${job.id} created`);
    this.#tracked.set(job.id, { stem });
    return this.#follow(job, save, ctx);
  }

  async resume(jobId: string, save: boolean, ctx: ToolContext): Promise<CallToolResult> {
    const tracked = this.#tracked.get(jobId);
    if (tracked?.job && !save) return linksResult(tracked.job, ctx);
    if (tracked?.job && tracked.save) return savedResult(tracked.job, await waitFor(tracked.save, ctx), ctx);
    return this.#follow(await this.api.getJob(jobId, 0, ctx.signal), save, ctx);
  }

  async #follow(created: Job, save: boolean, ctx: ToolContext): Promise<CallToolResult> {
    const deadline = ctx.startedAt + this.config.waitSeconds * 1000;

    let job = created;
    while (job.status !== "succeeded" && job.status !== "failed") {
      const remainingS = Math.floor((deadline - Date.now()) / 1000);
      if (remainingS <= 0) return runningResult(job, ctx);

      ctx.progress(`clips ${job.status}${job.stage ? ` (${job.stage})` : ""}, ${jobAge(job) ?? Math.round(elapsedSeconds(ctx))} s`);
      job = await this.api.getJob(job.id, Math.min(POLL_WAIT_S, remainingS), ctx.signal);
    }

    log(`clips job ${job.id} ${job.status}`);
    if (job.status === "failed") return failedResult(job);

    const tracked = this.#tracked.get(job.id) ?? {};
    tracked.job ??= job;
    this.#tracked.set(job.id, tracked);
    if (!save) return linksResult(tracked.job, ctx);

    // Calls that find the job done at the same time share one save
    tracked.save ??= this.#startSave(tracked.job, tracked, ctx);
    return savedResult(tracked.job, await waitFor(tracked.save, ctx), ctx);
  }

  // The save runs on its own signal, not on the call that started it.
  // One that threw or saved nothing is dropped, so the next call tries again
  #startSave(job: Job, tracked: Tracked, ctx: ToolContext): SharedSave {
    const stop = new AbortController();
    const saved = this.#save(job, tracked.stem ?? `clips-${job.id.slice(-6)}`, { ...ctx, signal: stop.signal }).then(
      (result) => {
        if (!result.files.some((file) => file.path)) tracked.save = undefined;
        return result;
      },
      (error: unknown) => {
        tracked.save = undefined;
        throw error;
      },
    );
    return { saved, stop, waiting: 0 };
  }

  // Each job gets a folder of its own, named after its video, so nothing already on disk is ever overwritten
  async #save(job: Job, stem: string, ctx: ToolContext): Promise<SavedJob> {
    const planned = plannedFiles(job.result?.clips ?? []);
    if (planned.length === 0) return { files: [] };

    const base = await this.workspace.baseDir();
    const dir = resolvePath(this.config.outputDir, base);
    ctx.progress(`saving ${job.result?.clips.length} clip(s) to ${dir}`);

    let folder: string;
    try {
      folder = await claimFolder(await outputRoot(dir, base), safeName(stem));
    } catch (error) {
      const reason = `couldn't write to ${dir} (${errorMessage(error)}); set CLIPSDK_OUTPUT_DIR to a writable folder`;
      log(reason);
      return { files: planned.map((file) => ({ clip: file.clip, kind: file.kind, url: displayUrl(file.url), error: reason })), error: reason };
    }

    const budget = this.api.outputBudget();
    const files = await mapLimited(planned, PARALLEL_DOWNLOADS, async (file): Promise<SavedFile> => {
      const shown = displayUrl(file.url);
      let target: string | undefined;
      try {
        target = await claim(folder, file.name);
        return { clip: file.clip, kind: file.kind, url: shown, path: target, bytes: await this.api.download(file.url, target, ctx.signal, budget) };
      } catch (error) {
        if (target !== undefined) await discard(target).catch(() => {});
        log(`saving ${shown} failed`, error);
        return { clip: file.clip, kind: file.kind, url: shown, error: fileError(error) };
      }
    });

    // A folder we made and left empty goes again, so the next try can have its name
    if (!files.some((file) => file.path)) {
      await rmdir(path.join(folder, CAPTIONS)).catch(() => {});
      await rmdir(folder).catch(() => {});
      return { files, error: files.find((file) => file.error)?.error };
    }
    return { folder, files };
  }
}

// 01-the-title.mp4 and .jpg side by side, best first; subtitles go in captions/ so players don't auto-load them on top of the burned-in captions
export function plannedFiles(clips: Clip[]): PlannedFile[] {
  return clips.flatMap((clip, index) => {
    const stem = `${String(index + 1).padStart(2, "0")}-${slugify(clip.title) || "clip"}`;
    return (Object.keys(EXTENSIONS) as FileKind[]).flatMap((kind) => {
      const url = clip[kind];
      if (url === null) return [];

      const name = `${stem}${EXTENSIONS[kind]}`;
      return [{ clip: index + 1, kind, url, name: kind === "srt" || kind === "vtt" ? path.join(CAPTIONS, name) : name }];
    });
  });
}

// A folder inside the project is walked without following any link, since the project may be a cloned repo; one named elsewhere is the user's own
async function outputRoot(dir: string, base: string): Promise<string> {
  const realBase = await realpath(base);
  const project = [base, realBase].find((root) => root === dir || isInside(root, dir));
  if (project !== undefined) return realDir(realBase, path.join(realBase, path.relative(project, dir)));

  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

// mkdir makes the folder or fails, so two saves never share one; a name that's taken gets the next number
async function claimFolder(root: string, name: string): Promise<string> {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const folder = path.join(root, attempt === 1 ? name : `${name}-${attempt}`);
    try {
      await mkdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    return realDir(root, folder);
  }
  throw new Error(`no free folder name left in ${root}`);
}

// The folder is new, but a name in it is still claimed as an empty file that only its own download replaces,
// so whatever turns up in it meanwhile is never overwritten
async function claim(folder: string, name: string): Promise<string> {
  const target = await placeIn(folder, name);
  try {
    await (await open(target, "wx")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${name} already exists in ${folder} and was left alone`);
    throw error;
  }
  return target;
}

// A cancelled call stops waiting at once; the save stops when the last call waiting on it is cancelled
async function waitFor(save: SharedSave, ctx: ToolContext): Promise<SavedJob> {
  let stopWaiting!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    stopWaiting = () => reject(new DOMException("This operation was aborted", "AbortError"));
  });
  ctx.signal.addEventListener("abort", stopWaiting);
  if (ctx.signal.aborted) stopWaiting();

  save.waiting += 1;
  try {
    return await Promise.race([save.saved, cancelled]);
  } finally {
    ctx.signal.removeEventListener("abort", stopWaiting);
    save.waiting -= 1;
    if (save.waiting === 0 && ctx.signal.aborted) save.stop.abort();
  }
}

// At most `width` at once, results in order
async function mapLimited<T, R>(items: T[], width: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]!, index);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

// A name becomes one short plain file name: no folders, no leading dot, nothing Windows would trim or open as a device
export function safeName(name: string): string {
  const plain = shortened(name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "")).replace(/\.+$/, "");
  if (!plain) return "output";
  return isDeviceName(plain) ? plain.replace(/^[^.]*/, "$&_") : plain;
}

// Short enough that the numbered name and its .part file stay far below the 255 bytes file systems allow
function shortened(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const ext = path.extname(name);
  return ext.length <= 10 ? name.slice(0, MAX_NAME - ext.length) + ext : name.slice(0, MAX_NAME);
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}
