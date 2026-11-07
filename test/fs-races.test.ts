import type { RmOptions } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipSdk } from "../src/api.js";
import type { ToolContext } from "../src/context.js";
import { JobRunner } from "../src/jobs.js";
import { saveExclusive } from "../src/paths.js";
import { Workspace } from "../src/workspace.js";
import { GOOD_KEY, startFakeApi, type FakeApi } from "./fake-api.js";

const hooks = vi.hoisted(() => ({
  opening: undefined as ((file: string, flags: string | number) => Promise<void>) | undefined,
  opened: undefined as ((handle: FileHandle) => void) | undefined,
  removing: undefined as ((target: string) => void) | undefined,
  checked: undefined as ((target: string) => Promise<void>) | undefined,
}));

// Every call goes to the real file system; a test can step in around one
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(file: string, flags: string | number, mode?: number) {
      await hooks.opening?.(file, flags);
      const handle = await actual.open(file, flags, mode);
      hooks.opened?.(handle);
      return handle;
    },
    async rm(target: string, options?: RmOptions) {
      hooks.removing?.(target);
      return actual.rm(target, options);
    },
    async lstat(target: string) {
      try {
        return await actual.lstat(target);
      } finally {
        await hooks.checked?.(target);
      }
    },
  };
});

let out: string;

beforeEach(async () => {
  out = await realpath(await mkdtemp(path.join(os.tmpdir(), "clipsdk-races-")));
});

afterEach(async () => {
  hooks.opening = hooks.opened = hooks.removing = hooks.checked = undefined;
  await rm(out, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text);
}

describe("saveExclusive", () => {
  it("removes its temporary file even when closing it fails", async () => {
    hooks.opened = (handle) => {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
      };
    };

    await expect(saveExclusive(bytes("video"), path.join(out, "clip.mp4"))).rejects.toThrow(/EIO/);
    expect(await readdir(out)).toEqual([]);
  });
});

describe("download", () => {
  it("keeps counting a failed attempt's bytes while its file is still on disk", async () => {
    let hits = 0;
    const host = createServer((_req, res) => {
      hits += 1;
      if (hits > 1) return res.end("x".repeat(700));
      res.writeHead(200, { "content-length": "700" }).write("x".repeat(600));
      setTimeout(() => res.destroy(), 50);
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    hooks.removing = (target) => {
      if (target.endsWith(".part")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    };

    const sdk = new ClipSdk(base, "csdk_live_secret", { outputBytes: 1024 });
    const budget = sdk.outputBudget();
    try {
      await expect(sdk.download(`${base}/f/out/job_1/video.mp4`, path.join(out, "video.mp4"), signal(), budget)).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
      expect(budget.left).toBe(424);
    } finally {
      host.closeAllConnections();
      await new Promise((resolve) => host.close(resolve));
    }
  });
});

describe("saving a job's clips", () => {
  let api: FakeApi;

  beforeEach(async () => {
    api = await startFakeApi();
    api.scenario.clips = 1;
  });

  afterEach(() => api.close());

  interface Saved {
    folder?: string;
    save_error?: string;
    errors?: { clip: number; file: string; error: string }[];
    clips: Record<string, unknown>[];
  }

  const context = (): ToolContext => ({ signal: signal(), startedAt: Date.now(), progress: () => {} });
  const folder = () => path.join(out, "clipsdk-output", "talk");
  const srt = () => path.join(folder(), "captions", "01-why-pricing-pages-fail.srt");

  // Someone else puts a file in our new folder right before we claim its name
  const plantedBeforeTheClaim = () => {
    hooks.opening = async (file, flags) => {
      if (flags !== "wx" || file !== srt()) return;
      hooks.opening = undefined;
      await writeFile(file, "theirs");
    };
  };

  async function save(): Promise<Saved> {
    const config = { apiKey: GOOD_KEY, baseUrl: api.baseUrl, outputDir: "clipsdk-output", waitSeconds: 30 };
    const runner = new JobRunner(new ClipSdk(api.baseUrl, GOOD_KEY), config, new Workspace({ CLAUDE_PROJECT_DIR: out }, async () => undefined));
    const result: CallToolResult = await runner.start({ video_url: "https://example.com/talk.mp4" }, "talk", true, context());
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return JSON.parse(text.slice(text.indexOf("\n{") + 1)) as Saved;
  }

  it("never overwrites a file that turns up in its folder", async () => {
    plantedBeforeTheClaim();

    const saved = await save();

    expect(await readFile(srt(), "utf8")).toBe("theirs");
    expect(saved.clips[0]).toMatchObject({ video: path.join(folder(), "01-why-pricing-pages-fail.mp4"), srt: null });
    expect(saved.errors).toEqual([expect.objectContaining({ clip: 1, file: "srt", error: expect.stringContaining("already exists") })]);
    expect((await readdir(folder())).sort()).toEqual(["01-why-pricing-pages-fail.jpg", "01-why-pricing-pages-fail.mp4", "captions"]);
  });

  it("only removes its own claims when downloads fail", async () => {
    plantedBeforeTheClaim();
    api.scenario.onFile = (pathname, res) => {
      if (!pathname.endsWith("/captions.vtt")) return false;
      res.writeHead(404).end();
      return true;
    };

    const saved = await save();

    expect(saved.errors?.map((error) => error.file).sort()).toEqual(["srt", "vtt"]);
    expect(saved.errors?.find((error) => error.file === "vtt")?.error).toContain("HTTP 404");
    expect(await readdir(path.dirname(srt()))).toEqual(["01-why-pricing-pages-fail.srt"]);
    expect(await readFile(srt(), "utf8")).toBe("theirs");
  });

  it("leaves no folder behind when nothing could be saved", async () => {
    api.scenario.onFile = (_pathname, res) => {
      res.writeHead(404).end();
      return true;
    };

    const saved = await save();

    expect(saved.folder).toBeUndefined();
    expect(saved.save_error).toContain("HTTP 404");
    expect(saved.clips[0]).toMatchObject({ video: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/f\/out\/job_\w+\/0\/video\.mp4\?s=sig0$/) });
    expect(await readdir(path.join(out, "clipsdk-output"))).toEqual([]);
  });

  it("gives every save of the same video a folder of its own", async () => {
    const [first, second] = await Promise.all([save(), save()]);

    expect([first.folder, second.folder].sort()).toEqual([folder(), `${folder()}-2`]);
  });
});
