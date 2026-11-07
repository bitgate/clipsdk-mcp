import { lstatSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipSdk } from "../src/api.js";
import type { ToolContext } from "../src/context.js";
import { Media } from "../src/media.js";
import { Workspace } from "../src/workspace.js";
import { GOOD_KEY, startFakeApi, type FakeApi } from "./fake-api.js";

const hooks = vi.hoisted(() => ({
  resolving: undefined as ((target: string) => void) | undefined,
  opening: undefined as ((target: string) => void) | undefined,
  opened: undefined as ((target: string) => void) | undefined,
}));

// Windows has no O_NOFOLLOW, so here open follows a link at the last step too
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async realpath(target: string) {
      hooks.resolving?.(target);
      return actual.realpath(target);
    },
    async open(target: string, flags: string | number, mode?: number) {
      hooks.opening?.(target);
      try {
        return await actual.open(target, flags, mode);
      } finally {
        hooks.opened?.(target);
      }
    },
  };
});

const MP4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypisom\0\0\x02\0isomiso2", "latin1"), Buffer.from("local video bytes")]);
const PRIVATE_MP4 = Buffer.concat([MP4, Buffer.from(" and a private recording")]);

let api: FakeApi;
let root: string;
let project: string;
let media: Media;

beforeEach(async () => {
  api = await startFakeApi();
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "clipsdk-swaps-")));
  project = path.join(root, "project");
  await mkdir(path.join(project, "media"), { recursive: true });
  await mkdir(path.join(root, "private"));
  await writeFile(path.join(project, "media", "clip.mp4"), MP4);
  await writeFile(path.join(root, "private", "clip.mp4"), PRIVATE_MP4);
  media = new Media(new ClipSdk(api.baseUrl, GOOD_KEY), new Workspace({ CLAUDE_PROJECT_DIR: project }, async () => undefined), 50);
});

afterEach(async () => {
  hooks.resolving = hooks.opening = hooks.opened = undefined;
  await api.close();
  await rm(root, { recursive: true, force: true });
});

const context = (): ToolContext => ({ signal: new AbortController().signal, startedAt: Date.now(), progress: () => {} });
const clip = () => path.join(project, "media", "clip.mp4");

// The upload checks resolve the project folder right after walking the file's path, so that's where the swap lands
function swapAfterThePathCheck(swap: () => void): void {
  hooks.resolving = (target) => {
    if (target !== project) return;
    hooks.resolving = undefined;
    swap();
  };
}

describe("uploads where the file system can't refuse links", () => {
  it("refuse a file swapped for a link after its path was checked", async () => {
    swapAfterThePathCheck(() => {
      rmSync(clip());
      symlinkSync(path.join(root, "private", "clip.mp4"), clip());
    });

    await expect(media.toUrl(clip(), context())).rejects.toThrow(/changed while it was being checked/);
    expect(api.tickets).toEqual([]);
    expect(api.uploads).toEqual([]);
  });

  it("refuse a file that only turns into a link while it is being opened", async () => {
    const original = `${clip()}.original`;
    const isLink = () => lstatSync(clip()).isSymbolicLink();
    const toLink = () => {
      renameSync(clip(), original);
      symlinkSync(path.join(root, "private", "clip.mp4"), clip());
    };
    const back = () => {
      rmSync(clip());
      renameSync(original, clip());
    };
    swapAfterThePathCheck(toLink);
    hooks.opening = (target) => target === clip() && !isLink() && toLink();
    hooks.opened = (target) => target === clip() && isLink() && back();

    await expect(media.toUrl(clip(), context())).rejects.toThrow(/changed while it was being checked/);
    expect(api.tickets).toEqual([]);
    expect(api.uploads).toEqual([]);
  });

  it("refuse a file whose folder was swapped for a link after its path was checked", async () => {
    swapAfterThePathCheck(() => {
      renameSync(path.join(project, "media"), path.join(project, "media-moved"));
      symlinkSync(path.join(root, "private"), path.join(project, "media"));
    });

    await expect(media.toUrl(clip(), context())).rejects.toThrow(/changed while it was being checked/);
    expect(api.tickets).toEqual([]);
    expect(api.uploads).toEqual([]);
  });

  it("say a file is missing when it goes away after its path was checked", async () => {
    swapAfterThePathCheck(() => rmSync(clip()));

    await expect(media.toUrl(clip(), context())).rejects.toThrow(/^File not found: /);
  });

  it("take a file:// URL whose host is localhost", async () => {
    await expect(media.toUrl(`file://localhost${clip()}`, context())).resolves.toMatch(/\/f\/in\//);
    expect(api.uploads).toHaveLength(1);
  });
});
