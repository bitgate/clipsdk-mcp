import { renameSync, symlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discard, placeIn, resolveLinks, saveExclusive } from "../src/paths.js";

const uuid = vi.hoisted(() => ({ next: undefined as (() => string) | undefined }));

// We pick the "random" temporary name, so a test can plant something at it or swap a folder just before it's used
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomUUID: () => uuid.next?.() ?? crypto.randomUUID() };
});

let root: string;
let out: string;
let victim: string;

beforeEach(async () => {
  uuid.next = undefined;
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "clipsdk-paths-")));
  out = path.join(root, "out");
  victim = path.join(root, "victim");
  await mkdir(out);
  await mkdir(victim);
  await writeFile(path.join(victim, "clip.mp4"), "precious");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text);
}

function swapOutForVictim(): void {
  renameSync(out, `${out}-moved`);
  symlinkSync(victim, out);
}

describe("saveExclusive", () => {
  it("saves a file", async () => {
    await saveExclusive(bytes("video"), path.join(out, "clip.mp4"));

    expect(await readFile(path.join(out, "clip.mp4"), "utf8")).toBe("video");
    expect(await readdir(out)).toEqual(["clip.mp4"]);
  });

  it("never writes through a link planted at its temporary name", async () => {
    uuid.next = () => "planted";
    await symlink(path.join(victim, "clip.mp4"), path.join(out, ".clip.mp4.planted.part"));

    await expect(saveExclusive(bytes("video"), path.join(out, "clip.mp4"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(victim, "clip.mp4"), "utf8")).toBe("precious");
  });

  it("opens nothing in a folder that became a link before the save", async () => {
    const destination = path.join(out, "clip.mp4");
    swapOutForVictim();

    await expect(saveExclusive(bytes("video"), destination)).rejects.toThrow(/moved or became a link/);
    expect(await readdir(victim)).toEqual(["clip.mp4"]);
  });

  it("never renames into a folder that became a link while it was writing", async () => {
    uuid.next = () => {
      swapOutForVictim();
      return "swapped";
    };

    await expect(saveExclusive(bytes("video"), path.join(out, "clip.mp4"))).rejects.toThrow(/moved or became a link/);
    expect(await readFile(path.join(victim, "clip.mp4"), "utf8")).toBe("precious");
    expect(await readdir(victim)).toEqual(["clip.mp4"]);
  });
});

describe("discard", () => {
  it("never deletes through a folder that became a link", async () => {
    const file = path.join(out, "clip.mp4");
    swapOutForVictim();

    await expect(discard(file)).rejects.toThrow(/moved or became a link/);
    expect(await readFile(path.join(victim, "clip.mp4"), "utf8")).toBe("precious");
  });
});

describe("placeIn", () => {
  it("keeps every name inside the folder and creates subfolders itself", async () => {
    for (const name of ["../escape.mp4", "../created/escape.mp4", "/etc/passwd", path.join("captions", "..", "..", "escape.srt")]) {
      await expect(placeIn(out, name), name).rejects.toThrow();
    }
    expect(await readdir(root)).not.toContain("created");

    expect(await placeIn(out, path.join("captions", "clip.srt"))).toBe(path.join(out, "captions", "clip.srt"));
    expect((await lstat(path.join(out, "captions"))).isDirectory()).toBe(true);
  });

  it("refuses a link on the way", async () => {
    await symlink(victim, path.join(out, "captions"));

    await expect(placeIn(out, path.join("captions", "clip.srt"))).rejects.toThrow(/is a link/);
  });
});

describe("resolveLinks", () => {
  it("follows ordinary links to the real file", async () => {
    await symlink(path.join(victim, "clip.mp4"), path.join(out, "clip.mp4"));
    await symlink(out, path.join(root, "shortcut"));

    expect(await resolveLinks(path.join(root, "shortcut", "clip.mp4"))).toBe(path.join(victim, "clip.mp4"));
  });

  it("refuses a link to another machine without following it", async () => {
    for (const [index, target] of ["//attacker/share/clip.mp4", "\\\\attacker\\share\\clip.mp4"].entries()) {
      const link = path.join(out, `link-${index}.mp4`);
      await symlink(target, link);
      await expect(resolveLinks(link), target).rejects.toThrow(/links to another machine/);
    }
  });

  it("gives up on a loop of links", async () => {
    await symlink(path.join(out, "b"), path.join(out, "a"));
    await symlink(path.join(out, "a"), path.join(out, "b"));

    await expect(resolveLinks(path.join(out, "a"))).rejects.toThrow(/more than 40 links/);
  });
});
