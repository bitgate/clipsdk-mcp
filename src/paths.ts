import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { log } from "./log.js";

const MAX_LINKS = 40;

// Windows opens these as the device, whatever follows the first dot: NUL.txt is NUL
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// Two leading slashes or backslashes (\\server\share, \\?\, \\.\) or NT's \??\: on Windows, merely opening one reaches out to that host
const NETWORK_PATH = /^(?:[\\/]{2}|\\\?\?\\)/;

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

export function isNetworkPath(input: string): boolean {
  if (NETWORK_PATH.test(input)) return true;
  if (!/^file:/i.test(input) || !URL.canParse(input)) return false;

  const url = new URL(input);
  return url.hostname !== "" || NETWORK_PATH.test(url.pathname);
}

export function isDeviceName(name: string): boolean {
  return DEVICE_NAME.test(name.split(".")[0]!);
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Dot names (.ssh, .env, .aws) count below the project, and anywhere on a path outside it
export function hasHiddenSegment(file: string, base: string): boolean {
  const scope = isInside(base, file) ? path.relative(base, file) : file;
  return scope.split(/[\\/]/).some((name) => name.startsWith("."));
}

// We read every link before going through it, so one that leads to another machine is refused without being opened
export async function resolveLinks(file: string): Promise<string> {
  let at = path.parse(file).root;
  let names = path.relative(at, file).split(path.sep).filter(Boolean);

  for (let links = 0; names.length > 0; ) {
    const next = path.join(at, names.shift()!);
    if (!(await lstat(next)).isSymbolicLink()) {
      at = next;
      continue;
    }

    const target = await readlink(next);
    if (isNetworkPath(target)) throw new LinkError(`${next} links to another machine`);
    if (++links > MAX_LINKS) throw new LinkError(`${file} goes through more than ${MAX_LINKS} links`);

    const leadsTo = path.resolve(at, target);
    at = path.parse(leadsTo).root;
    names = [...path.relative(at, leadsTo).split(path.sep).filter(Boolean), ...names];
  }
  return realpath(at);
}

// We walk down from a real folder with lstat and create what's missing ourselves, so no link below it is ever followed
export async function realDir(start: string, dir: string): Promise<string> {
  if (dir !== start && !isInside(start, dir)) throw new LinkError(`${dir} is outside ${start}`);

  let at = start;
  for (const name of path.relative(start, dir).split(path.sep).filter(Boolean)) {
    at = path.join(at, name);
    await mkdir(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });

    const info = await lstat(at);
    if (info.isSymbolicLink()) throw new LinkError(`${at} is a link, and nothing is saved through one`);
    if (!info.isDirectory()) throw new LinkError(`${at} is not a folder`);
  }

  const real = await realpath(at);
  if (real !== start && !isInside(start, real)) throw new LinkError(`${at} moved out of ${start}`);
  return real;
}

export async function placeIn(root: string, name: string): Promise<string> {
  const target = path.resolve(root, name);
  return path.join(await realDir(root, path.dirname(target)), path.basename(target));
}

// A folder we resolved still resolves to itself, unless it moved or a link took its place
async function assertUnmoved(dir: string): Promise<void> {
  if ((await realpath(dir)) !== dir) throw new LinkError(`${dir} moved or became a link while saving`);
}

export async function discard(file: string): Promise<void> {
  await assertUnmoved(path.dirname(file));
  await rm(file, { force: true });
}

// We stream into a fresh name that is never a link and rename it into place while its folder still resolves to itself.
// Node has no openat or renameat, so the folder can still be swapped in the moment between that check and the rename
export async function saveExclusive(source: AsyncIterable<Uint8Array>, destination: string, onDiscarded?: () => void): Promise<void> {
  const dir = path.dirname(destination);
  await assertUnmoved(dir);

  const temp = path.join(dir, `.${path.basename(destination)}.${randomUUID()}.part`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
  try {
    await pipeline(source, handle.createWriteStream());
    await handle.close();
    await assertUnmoved(dir);
    await rename(temp, destination);
  } catch (error) {
    // The .part name is ours alone, so it goes even when its folder moved or closing failed, and only then is its space free again
    await handle.close().catch(() => {});
    await rm(temp, { force: true }).then(onDiscarded, (rmError: unknown) => log(`couldn't remove ${temp}`, rmError));
    throw error;
  }
}
