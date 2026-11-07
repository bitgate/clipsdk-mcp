import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ClipSdk } from "../src/api.js";
import type { ToolContext } from "../src/context.js";
import { JobRunner } from "../src/jobs.js";
import { MAX_UPLOAD_BYTES, Media } from "../src/media.js";
import { errorResult } from "../src/results.js";
import { createServer } from "../src/server.js";
import { Workspace } from "../src/workspace.js";
import { GOOD_KEY, startFakeApi, type FakeApi } from "./fake-api.js";

interface ClipEntry {
  rank: number;
  score: number | null;
  title: string;
  post_caption: string;
  video: string | null;
  poster: string | null;
  srt: string | null;
  vtt: string | null;
}

interface Outcome {
  isError: boolean;
  text: string;
  json: {
    status?: string;
    job_id?: string;
    folder?: string;
    save_error?: string;
    clips?: ClipEntry[];
    errors?: { clip: number; file: string; url: string; error: string }[];
    hint?: string;
    video_url?: string;
  };
}

const MP4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypisom\0\0\x02\0isomiso2", "latin1"), Buffer.from("local video bytes")]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from("webm local video bytes")]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const MP3 = Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1");
const BEST = "01-why-pricing-pages-fail";
const LINK = "https://example.com/podcast.mp4";

let api: FakeApi;
let dir: string;

beforeEach(async () => {
  api = await startFakeApi();
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "clipsdk-mcp-")));
  await writeFile(path.join(dir, "talk.mp4"), MP4);
});

afterEach(async () => {
  await api.close();
  await rm(dir, { recursive: true, force: true });
});

async function connect(env: Record<string, string | undefined> = {}): Promise<Client> {
  const server = createServer({ CLIPSDK_KEY: GOOD_KEY, CLIPSDK_BASE_URL: api.baseUrl, CLAUDE_PROJECT_DIR: dir, CLIPSDK_WAIT_S: "30", ...env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>, onprogress?: (message: string) => void): Promise<Outcome> {
  const options = onprogress ? { onprogress: (progress: { message?: string }) => onprogress(progress.message ?? "") } : undefined;
  return outcomeOf((await client.callTool({ name, arguments: args }, undefined, options)) as CallToolResult);
}

function outcomeOf(result: CallToolResult): Outcome {
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const start = text.indexOf("\n{");
  return { isError: result.isError === true, text, json: start >= 0 ? JSON.parse(text.slice(start + 1)) : {} };
}

async function tempDir(prefix: string): Promise<string> {
  const created = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  onTestFinished(() => rm(created, { recursive: true, force: true }));
  return created;
}

const context = (): ToolContext => ({ signal: new AbortController().signal, startedAt: Date.now(), progress: () => {} });
const workspace = () => new Workspace({ CLAUDE_PROJECT_DIR: dir }, async () => undefined);
const runnerFor = (outputDir = "clipsdk-output", sdk = new ClipSdk(api.baseUrl, GOOD_KEY)) =>
  new JobRunner(sdk, { apiKey: GOOD_KEY, baseUrl: api.baseUrl, outputDir, waitSeconds: 30 }, workspace());

const output = (...parts: string[]) => path.join(dir, "clipsdk-output", ...parts);
const holdPuts = () => {
  let release!: () => void;
  api.scenario.holdPuts = new Promise<void>((resolve) => (release = resolve));
  onTestFinished(() => release());
  return () => release();
};

it("lists its three tools", async () => {
  const { tools } = await (await connect()).listTools();

  expect(tools.map((tool) => tool.name)).toEqual(["create_clips", "get_job", "upload_file"]);
  expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual([
    "video",
    "clips",
    "min_seconds",
    "max_seconds",
    "aspect",
    "reframe",
    "captions",
    "language",
    "prompt",
    "webhook_url",
    "save",
  ]);
  expect(tools[0]!.inputSchema.required).toEqual(["video"]);
  expect(tools[0]!.description).toContain("$0.03 per source minute");
});

describe("create_clips", () => {
  it("uploads a local file, waits for the job and saves every clip", async () => {
    const client = await connect();
    const progress: string[] = [];
    const outcome = await call(client, "create_clips", { video: "talk.mp4", clips: 2, aspect: "1:1", captions: "none", prompt: "pricing" }, (message) => progress.push(message));

    expect(outcome.isError).toBe(false);
    expect(api.tickets).toEqual([{ filename: "talk.mp4", size: MP4.length, video_url: expect.stringContaining("/f/in/") }]);
    expect(api.uploads).toEqual([{ filename: "talk.mp4", size: MP4.length, bytes: MP4.length, authorization: undefined }]);
    expect(api.created).toEqual([{ body: { video_url: api.tickets[0]!.video_url, clips: 2, aspect: "1:1", captions: false, prompt: "pricing" }, key: expect.any(String) }]);

    expect(outcome.json.folder).toBe(output("talk"));
    expect(outcome.json.clips?.[0]).toMatchObject({
      rank: 1,
      score: 90,
      title: "Why pricing pages fail",
      post_caption: "Your pricing page is lying to you",
      video: output("talk", `${BEST}.mp4`),
      poster: output("talk", `${BEST}.jpg`),
      srt: output("talk", "captions", `${BEST}.srt`),
      vtt: output("talk", "captions", `${BEST}.vtt`),
    });
    expect(await readFile(output("talk", `${BEST}.mp4`), "utf8")).toBe(`bytes of /f/out/${outcome.json.job_id}/0/video.mp4`);
    expect(api.downloads.map((download) => download.query)).toEqual(Array(8).fill(expect.stringMatching(/^\?s=sig[01]$/)));
    expect(outcome.text).toContain(`best first: ${output("talk", `${BEST}.mp4`)} (score 90)`);
    expect(progress.length).toBeGreaterThan(1);
  });

  it("passes a link to the file straight through", async () => {
    const args = { clips: 3, min_seconds: 30, max_seconds: 45, reframe: "center", language: "en", webhook_url: "https://hooks.example.com/clips" };
    const outcome = await call(await connect(), "create_clips", { video: LINK, ...args });

    expect(outcome.json.status).toBe("succeeded");
    expect(api.created[0]?.body).toEqual({ video_url: LINK, ...args });
    expect(api.tickets).toEqual([]);
    expect(outcome.json.folder).toBe(output("podcast"));
  });

  it("saves another run into a folder of its own, and reuses the upload", async () => {
    const client = await connect();
    await call(client, "create_clips", { video: "talk.mp4" });
    const second = await call(client, "create_clips", { video: "./talk.mp4" });

    expect(second.json.folder).toBe(output("talk-2"));
    expect(api.tickets).toHaveLength(1);
    expect(api.created.map((job) => job.body.video_url)).toEqual([api.tickets[0]!.video_url, api.tickets[0]!.video_url]);
  });

  it("checks the clip lengths before uploading anything", async () => {
    const client = await connect();
    const cases: [Record<string, number>, string][] = [
      [{ min_seconds: 60 }, "max_seconds must be at least min_seconds + 5: pass max_seconds 65 or more (it defaults to 60)."],
      [{ min_seconds: 30, max_seconds: 32 }, "max_seconds must be at least min_seconds + 5: pass max_seconds 35 or more."],
      [{ min_seconds: 88, max_seconds: 90 }, "min_seconds can be at most 85"],
    ];
    for (const [lengths, message] of cases) {
      const outcome = await call(client, "create_clips", { video: "talk.mp4", ...lengths });
      expect(outcome.isError, JSON.stringify(lengths)).toBe(true);
      expect(outcome.text).toContain(message);
    }
    expect(api.requests).toEqual([]);
  });

  it("refuses a webhook clipsdk won't call before uploading anything", async () => {
    const client = await connect();
    for (const webhook_url of ["http://hooks.example.com/clips", "https://hooks.example.com:8443/clips", "https://user:pass@hooks.example.com/clips", "hooks"]) {
      const outcome = await call(client, "create_clips", { video: "talk.mp4", webhook_url });
      expect(outcome.isError, webhook_url).toBe(true);
      expect(outcome.text, webhook_url).toMatch(/^webhook_url must/);
    }
    expect(api.requests).toEqual([]);
  });

  it("returns the links without downloading when save is false", async () => {
    const outcome = await call(await connect(), "create_clips", { video: LINK, save: false });

    expect(outcome.json.folder).toBeUndefined();
    expect(outcome.json.clips?.[0]?.video).toBe(`${api.baseUrl}/f/out/${outcome.json.job_id}/0/video.mp4?s=sig0`);
    expect(outcome.text).toMatch(/^Done: 2 clip\(s\), not downloaded/);
    expect(api.downloads).toEqual([]);
  });

  it("says so when the video has no moments to clip", async () => {
    api.scenario.clips = 0;

    const outcome = await call(await connect(), "create_clips", { video: LINK });

    expect(outcome.isError).toBe(false);
    expect(outcome.text).toMatch(/^Done, but clipsdk found no moments/);
    expect(outcome.json.clips).toEqual([]);
    await expect(readdir(output())).rejects.toThrow(/ENOENT/);
  });
});

describe("get_job", () => {
  it("hands back a job id when the wait runs out, then saves the clips once done", async () => {
    api.scenario.pollsUntilDone = 2;
    const client = await connect({ CLIPSDK_WAIT_S: "0" });

    const started = await call(client, "create_clips", { video: LINK });
    expect(started.json.status).toBe("running");
    expect(started.text).toContain(`Call get_job with job_id "${started.json.job_id}"`);

    const pending = await call(client, "get_job", { job_id: started.json.job_id });
    expect(pending.json.status).toBe("running");

    const done = await call(client, "get_job", { job_id: started.json.job_id });
    expect(done.json.status).toBe("succeeded");
    expect(done.json.folder).toBe(output("podcast"));
    expect(done.json.clips?.map((clip) => clip.video)).toEqual([output("podcast", `${BEST}.mp4`), output("podcast", "02-moment-2.mp4")]);

    const requests = api.requests.length;
    const again = await call(client, "get_job", { job_id: started.json.job_id });
    expect(again.json.folder).toBe(output("podcast"));
    expect(api.requests).toHaveLength(requests);
  });

  it("saves a job this session didn't start under its id", async () => {
    const job = await new ClipSdk(api.baseUrl, GOOD_KEY).createClips({ video_url: LINK }, context().signal);

    const outcome = await call(await connect(), "get_job", { job_id: job.id });

    expect(outcome.json.folder).toBe(output(`clips-${job.id.slice(-6)}`));
  });

  it("refuses a job id that can't be one", async () => {
    const client = await connect();
    const refused = await client.callTool({ name: "get_job", arguments: { job_id: "../../v1/clips" } }).then((result) => (result as CallToolResult).isError === true, () => true);

    expect(refused).toBe(true);
    expect(api.requests).toEqual([]);
  });

  it("tries a save again when it failed before saving anything", async () => {
    let roots = ["file:///bad%2Fpath"];
    const roaming = new Workspace({}, async () => roots);
    const config = { apiKey: GOOD_KEY, baseUrl: api.baseUrl, outputDir: output(), waitSeconds: 30 };
    const runner = new JobRunner(new ClipSdk(api.baseUrl, GOOD_KEY), config, roaming);

    await expect(runner.start({ video_url: LINK }, "talk", true, context())).rejects.toThrow(/encoded \/ characters/);
    const jobId = api.requests.map((request) => /job_[a-z0-9]{20}/.exec(request)?.[0]).find(Boolean)!;
    roots = [`file://${dir}`];
    roaming.invalidate();

    const retried = outcomeOf(await runner.resume(jobId, true, context()));
    expect(retried.json.folder).toBe(output("talk"));
  });

  it("shares one save between calls that find the job done at the same time", async () => {
    const client = await connect({ CLIPSDK_WAIT_S: "0" });
    const started = await call(client, "create_clips", { video: LINK });

    const [first, second] = await Promise.all([1, 2].map(() => call(client, "get_job", { job_id: started.json.job_id })));

    expect(first!.json.folder).toBe(output("podcast"));
    expect(second!.json.folder).toBe(output("podcast"));
    expect(api.downloads).toHaveLength(8);
  });

  // Two calls wait on one save that the first one started, while every download hangs until released
  async function sharedSave() {
    const job = await new ClipSdk(api.baseUrl, GOOD_KEY).createClips({ video_url: LINK }, context().signal);
    const runner = runnerFor();

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const dropped: string[] = [];
    api.scenario.onFile = async (pathname, res) => {
      res.on("close", () => {
        if (!res.writableFinished) dropped.push(pathname);
      });
      await released;
      if (!res.destroyed) res.end(`bytes of ${pathname}`);
      return true;
    };
    onTestFinished(release);

    const calls = [new AbortController(), new AbortController()];
    const first = runner.resume(job.id, true, { ...context(), signal: calls[0]!.signal });
    await vi.waitFor(() => expect(api.downloads).toHaveLength(4));
    const second = runner.resume(job.id, true, { ...context(), signal: calls[1]!.signal });
    return { job, runner, calls, settled: Promise.allSettled([first, second]), release, dropped };
  }

  it("keeps saving for the other calls when the call that started the save is cancelled", async () => {
    const { job, calls, settled, release, dropped } = await sharedSave();

    calls[0]!.abort("the client went away");
    release();
    const [cancelled, waited] = await settled;

    expect(cancelled).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
    expect(errorResult((cancelled as PromiseRejectedResult).reason).content).toEqual([{ type: "text", text: "Cancelled." }]);
    const outcome = outcomeOf((waited as PromiseFulfilledResult<CallToolResult>).value);
    expect(outcome.json.errors).toBeUndefined();
    expect(await readFile(outcome.json.clips![0]!.video!, "utf8")).toBe(`bytes of /f/out/${job.id}/0/video.mp4`);
    expect(dropped).toEqual([]);
  });

  it("stops the save once every call waiting on it is cancelled", async () => {
    const { job, runner, calls, settled, dropped } = await sharedSave();
    const late = runner.resume(job.id, true, { ...context(), signal: AbortSignal.abort("the client went away") }).catch((error: unknown) => error);

    for (const call of calls) call.abort("the client went away");
    await vi.waitFor(() => expect(dropped).toHaveLength(4));

    expect(await late).toMatchObject({ name: "AbortError" });
    expect(await settled).toMatchObject([
      { status: "rejected", reason: { name: "AbortError" } },
      { status: "rejected", reason: { name: "AbortError" } },
    ]);
    await vi.waitFor(async () => expect(await readdir(output(), { recursive: true })).toEqual([]));
  });

  it("tries a save again when it saved nothing", async () => {
    await writeFile(path.join(dir, "blocked"), "");
    const runner = runnerFor(path.join(dir, "blocked"));

    const refused = outcomeOf(await runner.start({ video_url: LINK }, "talk", true, context()));
    expect(refused.isError).toBe(false);
    expect(refused.json.save_error).toMatch(/^couldn't write to /);
    expect(refused.json.clips?.[0]?.video).toMatch(/\/f\/out\/job_\w+\/0\/video\.mp4\?s=sig0$/);

    await rm(path.join(dir, "blocked"));
    const retried = outcomeOf(await runner.resume(refused.json.job_id!, true, context()));
    expect(retried.json.folder).toBe(path.join(dir, "blocked", "talk"));
  });

  it("keeps a save that saved some of the files", async () => {
    api.scenario.onFile = (pathname, res) => {
      if (!pathname.endsWith("/captions.srt")) return false;
      res.writeHead(404).end();
      return true;
    };
    const runner = runnerFor();

    const partial = outcomeOf(await runner.start({ video_url: LINK }, "talk", true, context()));
    const requests = api.requests.length;
    const again = outcomeOf(await runner.resume(partial.json.job_id!, true, context()));

    expect(partial.json.errors?.map((error) => [error.clip, error.file])).toEqual([
      [1, "srt"],
      [2, "srt"],
    ]);
    expect(partial.text).toContain("2 file(s) failed to download");
    expect(again.json).toEqual({ ...partial.json, elapsed_s: expect.any(Number) });
    expect(api.requests).toHaveLength(requests);
  });
});

describe("errors", () => {
  it("lists the fields the API rejected", async () => {
    api.scenario.createError = {
      status: 400,
      body: { error: { code: "INVALID_REQUEST", message: "invalid request", issues: [{ path: "video_url", message: "Must be a direct link to the video file" }] } },
    };
    const outcome = await call(await connect(), "create_clips", { video: LINK });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("- video_url: Must be a direct link to the video file");
  });

  it("explains a rejected key", async () => {
    const outcome = await call(await connect({ CLIPSDK_KEY: "csdk_live_wrong" }), "create_clips", { video: LINK });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("401");
    expect(outcome.text).toContain("CLIPSDK_KEY");
    expect(outcome.text).toContain("https://clipsdk.com/dashboard/keys");
    expect(outcome.text).toMatch(/\nRequest-Id: req_[a-z0-9]{16}$/);
  });

  it("asks for a key before calling the API", async () => {
    const outcome = await call(await connect({ CLIPSDK_KEY: undefined }), "create_clips", { video: "talk.mp4" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("CLIPSDK_KEY is not set");
    expect(api.requests).toHaveLength(0);
  });

  it("reports a missing file with the resolved path", async () => {
    const outcome = await call(await connect(), "create_clips", { video: "nope.mp4" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain(`File not found: ${path.join(dir, "nope.mp4")}`);
  });

  it("refuses files over the upload cap without sending them", async () => {
    await truncate(path.join(dir, "talk.mp4"), MAX_UPLOAD_BYTES + 1);
    const outcome = await call(await connect(), "create_clips", { video: "talk.mp4" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("over clipsdk's 5 GB limit");
    expect(api.requests).toHaveLength(0);
  });

  it("refuses links clipsdk can't fetch, and lets direct file links through", async () => {
    const client = await connect();
    const refused: [string, string][] = [
      ["http://localhost:3000/talk.mp4", "can't reach localhost"],
      ["https://192.168.1.20/talk.mp4", "can't reach 192.168.1.20"],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube links are web pages"],
      ["https://youtu.be/dQw4w9WgXcQ", "YouTube links are web pages"],
      ["https://vimeo.com/76979871", "Vimeo links are web pages"],
      ["https://www.tiktok.com/@someone/video/123", "TikTok links are web pages"],
      ["https://user:secret@example.com/talk.mp4", "user name or password"],
      ["https://example.com:8443/talk.mp4", "scheme's own port"],
      ["ftp://example.com/talk.mp4", "direct http(s) link"],
    ];
    for (const [video, message] of refused) {
      const outcome = await call(client, "create_clips", { video });
      expect(outcome.isError, video).toBe(true);
      expect(outcome.text, video).toContain(message);
    }
    expect(api.requests).toEqual([]);

    const direct = await call(client, "create_clips", { video: "https://player.vimeo.com/external/76979871.hd.mp4", save: false });
    expect(direct.json.status).toBe("succeeded");
  });

  it("retries server errors", async () => {
    api.scenario.failGets = 2;
    const outcome = await call(await connect(), "create_clips", { video: LINK });

    expect(outcome.isError).toBe(false);
    expect(outcome.json.status).toBe("succeeded");
  });

  it("hands an account limit back at once, with when to try again", async () => {
    api.scenario.createError = { status: 429, body: { error: { code: "RATE_LIMITED", message: "this account already has 3 jobs running" } }, headers: { "retry-after": "10" } };
    const outcome = await call(await connect(), "create_clips", { video: LINK });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("HTTP 429 RATE_LIMITED: this account already has 3 jobs running");
    expect(outcome.text).toContain("Try again in 10 s.");
    expect(api.requests.filter((request) => request === "POST /v1/clips")).toHaveLength(1);
  });

  it("refuses a job with more than 20 clips without downloading any", async () => {
    api.scenario.clips = 21;
    const outcome = await call(await connect(), "create_clips", { video: LINK });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("lists 21 clips, and clipsdk-mcp saves at most 20");
    expect(api.downloads).toEqual([]);
  });

  it("explains failed jobs, and which ones count against the account", async () => {
    const client = await connect();

    api.scenario.failJob = { code: "NO_SPEECH", message: "no speech found in this video" };
    const counted = await call(client, "create_clips", { video: LINK });
    expect(counted.isError).toBe(true);
    expect(counted.text).toMatch(/^Job job_\w+ failed: NO_SPEECH: no speech found in this video/);
    expect(counted.json.hint).toContain("heard no speech");
    expect(counted.json.hint).toContain("count toward the account's failed-job limit");

    api.scenario.failJob = { code: "INTERNAL", message: "something broke" };
    const ours = await call(client, "create_clips", { video: LINK });
    expect(ours.json.hint).toContain("safe to call create_clips again");
    expect(ours.json.hint).not.toContain("count toward");

    api.scenario.failJob = { code: "INSUFFICIENT_CREDIT", message: "this video costs up to $1.80 and the account has $0.20 of credit" };
    const broke = await call(client, "create_clips", { video: LINK });
    expect(broke.json.hint).toContain("https://clipsdk.com/dashboard/billing");
  });
});

describe("what gets uploaded", () => {
  it("uploads a video from anywhere on this machine", async () => {
    const downloads = path.join(await tempDir("clipsdk-home-"), "Downloads");
    await mkdir(downloads);
    await writeFile(path.join(downloads, "holiday.mp4"), MP4);

    const outcome = await call(await connect(), "upload_file", { path: path.join(downloads, "holiday.mp4") });

    expect(outcome.isError).toBe(false);
    expect(outcome.json.video_url).toBe(api.tickets[0]?.video_url);
    expect(outcome.text).toContain(`Pass this video_url to create_clips; clipsdk keeps it 7 days: ${api.tickets[0]?.video_url}`);
    expect(api.uploads).toMatchObject([{ filename: "holiday.mp4", bytes: MP4.length }]);
  });

  it("names the upload after the file, with an extension clipsdk takes", async () => {
    const files: [string, Buffer, string][] = [
      ["My Talk (final).MOV", MP4, "My_Talk_final.mov"],
      ["recording", WEBM, "recording.webm"],
      ["episode.m4v", MP4, "episode.mp4"],
      ["épisode 2.mkv", WEBM, "episode_2.mkv"],
    ];
    await Promise.all(files.map(([name, bytes]) => writeFile(path.join(dir, name), bytes)));

    const client = await connect();
    for (const [name] of files) expect((await call(client, "upload_file", { path: name })).isError, name).toBe(false);

    expect(api.tickets.map((ticket) => ticket.filename)).toEqual(files.map(([, , uploaded]) => uploaded));
  });

  it("never uploads a hidden file or anything in a hidden folder, even through a link", async () => {
    const home = await tempDir("clipsdk-home-");
    await mkdir(path.join(home, ".ssh"));
    await mkdir(path.join(home, "vault"));
    await Promise.all([writeFile(path.join(dir, ".env"), MP4), writeFile(path.join(home, ".ssh", "key.mp4"), MP4), writeFile(path.join(home, "vault", "key.mp4"), MP4)]);
    await symlink(path.join(home, ".ssh", "key.mp4"), path.join(dir, "innocent.mp4"));
    await symlink(path.join(home, "vault"), path.join(dir, ".secrets"));

    const client = await connect();
    for (const input of [".env", path.join(home, ".ssh", "key.mp4"), "~/.ssh/id_rsa", "innocent.mp4", ".secrets/key.mp4"]) {
      const outcome = await call(client, "upload_file", { path: input });
      expect(outcome.isError, input).toBe(true);
      expect(outcome.text, input).toContain("hidden");
    }
    expect(api.requests).toEqual([]);
  });

  it("only uploads files that start like an MP4, MOV, WebM or MKV video", async () => {
    await writeFile(path.join(dir, "notes.mp4"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n");
    await writeFile(path.join(dir, "settings.json"), '{"token": "secret"}');
    await writeFile(path.join(dir, "photo.mp4"), JPEG);
    await writeFile(path.join(dir, "song.mp4"), MP3);

    const client = await connect();
    for (const input of ["notes.mp4", "settings.json", "photo.mp4", "song.mp4"]) {
      expect((await call(client, "upload_file", { path: input })).text, input).toContain("doesn't look like an MP4, MOV, WebM or MKV video");
    }
    expect(api.requests).toEqual([]);
  });

  it("refuses folders and devices", async () => {
    await mkdir(path.join(dir, "folder.mp4"));

    const client = await connect();
    for (const input of ["folder.mp4", "/dev/zero"]) {
      expect((await call(client, "upload_file", { path: input })).text, input).toContain("is not a file");
    }
    expect(api.requests).toEqual([]);
  });

  it("never opens a path on another machine", async () => {
    await symlink("//attacker/share/talk.mp4", path.join(dir, "share.mp4"));
    const inputs = [
      "\\\\attacker\\share\\talk.mp4",
      "//attacker/share/talk.mp4",
      "\\\\?\\UNC\\attacker\\share\\talk.mp4",
      "\\\\.\\pipe\\talk",
      "file://attacker/share/talk.mp4",
      "share.mp4",
    ];

    const client = await connect();
    for (const input of inputs) {
      expect((await call(client, "create_clips", { video: input })).text, input).toContain("another machine");
    }
    expect(api.requests).toEqual([]);
  });

  it("uploads the file it checked, not one swapped in afterwards", async () => {
    const media = new Media(new ClipSdk(api.baseUrl, GOOD_KEY), workspace(), 30);
    const talk = path.join(dir, "talk.mp4");
    await utimes(talk, 1_700_000_000, 1_700_000_000);
    const checked = await media.localFile("talk.mp4");

    await writeFile(path.join(dir, "secret"), Buffer.alloc(MP4.length, "s"));
    await utimes(path.join(dir, "secret"), 1_700_000_000, 1_700_000_000);
    await rename(path.join(dir, "secret"), talk);

    await expect(media.upload(checked, context())).rejects.toThrow("changed while it was being checked");
    expect(api.requests).toEqual([]);
  });

  it("keeps uploading when a call runs out of time, and the next call picks it up", async () => {
    const release = holdPuts();
    const client = await connect({ CLIPSDK_WAIT_S: "1" });

    const first = await call(client, "create_clips", { video: "talk.mp4" });
    expect(first.isError).toBe(false);
    expect(first.json.status).toBe("uploading");
    expect(first.text).toContain("call create_clips again with the same arguments");
    expect(api.created).toEqual([]);

    release();
    await vi.waitFor(() => expect(api.uploads).toHaveLength(1));
    await call(client, "create_clips", { video: "talk.mp4" });

    expect(api.tickets).toHaveLength(1);
    expect(api.created).toHaveLength(1);
  });

  it("stops an upload once no call waits for it", async () => {
    const release = holdPuts();
    const media = new Media(new ClipSdk(api.baseUrl, GOOD_KEY), workspace(), 30);
    const file = await media.localFile("talk.mp4");
    const call = new AbortController();

    const cancelled = media.upload(file, { ...context(), signal: call.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(api.tickets).toHaveLength(1));
    await delay(100);
    call.abort(new DOMException("The client went away", "AbortError"));
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(api.droppedPuts).toBe(1));

    release();
    await expect(media.upload(file, context())).resolves.toMatchObject({ video_url: expect.stringContaining("/f/in/") });
    expect(api.tickets).toHaveLength(2);
    expect(api.uploads).toHaveLength(1);
  });

  it("explains a storage refusal", async () => {
    api.scenario.failPuts = 4;
    const outcome = await call(await connect(), "upload_file", { path: "talk.mp4" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("UPLOAD_FAILED: ServiceUnavailable: Please try again.");
  }, 15_000);
});

describe("where files are saved", () => {
  let victim: string;

  beforeEach(async () => {
    victim = await tempDir("clipsdk-victim-");
  });

  it("keeps titles from the API inside the clip's folder", async () => {
    api.scenario.clip = (index, file) => ({ title: index === 0 ? "../../../evil" : "C:\\Windows\\win.ini", video: file("video.mp4"), poster: null, srt: null, vtt: null });

    const outcome = await call(await connect(), "create_clips", { video: "talk.mp4" });

    expect(outcome.json.clips?.map((clip) => clip.video)).toEqual([output("talk", "01-evil.mp4"), output("talk", "02-c-windows-win-ini.mp4")]);
  });

  it("names the folder safely, whatever the video is called", async () => {
    const client = await connect();
    const cases: [string, string][] = [
      ["https://media.example.com/v/.env%E2%80%AEgpj.mp4", "env_gpj"],
      ["https://media.example.com/NUL.mp4", "NUL_"],
      ["https://media.example.com/%2e%2e%2f%2e%2e%2fescape.mp4", "escape"],
      [`https://media.example.com/${"x".repeat(200)}.mp4`, "x".repeat(64)],
    ];
    for (const [video, folder] of cases) expect((await call(client, "create_clips", { video })).json.folder, video).toBe(output(folder));
  });

  it("shortens a long title", async () => {
    api.scenario.clips = 1;
    api.scenario.clip = (_index, file) => ({ title: "word ".repeat(60), video: file("video.mp4"), poster: null, srt: null, vtt: null });

    const outcome = await call(await connect(), "create_clips", { video: "talk.mp4" });

    expect(path.basename(outcome.json.clips![0]!.video!)).toBe(`01-${"word-".repeat(9)}wor.mp4`);
  });

  it("never saves through a link where the output folder should be", async () => {
    await symlink(victim, path.join(dir, "clipsdk-output"));
    await symlink(victim, path.join(dir, "renders"));

    for (const outputDir of ["clipsdk-output", "renders/2026"]) {
      const outcome = await call(await connect({ CLIPSDK_OUTPUT_DIR: outputDir }), "create_clips", { video: "talk.mp4" });
      expect(outcome.json.save_error, outputDir).toContain("is a link");
    }
    expect(await readdir(victim)).toEqual([]);
  });

  it("counts a link at the folder's name as taken and leaves it alone", async () => {
    await mkdir(output(), { recursive: true });
    await symlink(victim, output("talk"));

    const outcome = await call(await connect(), "create_clips", { video: "talk.mp4" });

    expect(outcome.json.folder).toBe(output("talk-2"));
    expect((await lstat(output("talk"))).isSymbolicLink()).toBe(true);
    expect(await readdir(victim)).toEqual([]);
  });

  it("saves into a folder the user named outside the project, even one behind a link", async () => {
    const movies = path.join(await tempDir("clipsdk-home-"), "Movies");
    await symlink(victim, movies);

    const outcome = await call(await connect({ CLIPSDK_OUTPUT_DIR: movies }), "create_clips", { video: "talk.mp4" });

    expect(outcome.json.folder).toBe(path.join(victim, "talk"));
  });

  it("stops saving into a folder that is swapped for a link mid-save", async () => {
    await writeFile(path.join(victim, `${BEST}.srt`), "precious");
    api.scenario.clips = 1;
    api.scenario.onFile = async (pathname) => {
      if (!pathname.endsWith("/captions.srt")) return;
      await rename(output("talk", "captions"), output("talk", "captions-moved"));
      await symlink(victim, output("talk", "captions"));
    };

    const outcome = await call(await connect(), "create_clips", { video: "talk.mp4" });

    expect(outcome.json.clips?.[0]).toMatchObject({ video: output("talk", `${BEST}.mp4`), srt: null });
    expect(await readdir(victim)).toEqual([`${BEST}.srt`]);
    expect(await readFile(path.join(victim, `${BEST}.srt`), "utf8")).toBe("precious");
  });

  it("downloads at most 4 files at a time", async () => {
    let active = 0;
    let peak = 0;
    api.scenario.clips = 5;
    api.scenario.onFile = async (_pathname, res) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(50);
      active -= 1;
      res.end("x");
      return true;
    };

    const outcome = await call(await connect(), "create_clips", { video: "talk.mp4" });

    expect(outcome.json.clips).toHaveLength(5);
    expect(outcome.json.errors).toBeUndefined();
    expect(peak).toBe(4);
  });

  it("never shows a link's password or control characters", async () => {
    const logged: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    onTestFinished(() => stderr.mockRestore());
    api.scenario.clips = 1;
    api.scenario.clip = (_index, file) => ({
      title: "clip",
      video: file("video.mp4").replace("http://", "http://user:hunter2@"),
      poster: null,
      srt: "https://elsewhere.example/\u001b[2Jcaptions.srt",
      vtt: null,
    });

    const client = await connect();
    const saved = await call(client, "create_clips", { video: "talk.mp4" });
    const links = await call(client, "create_clips", { video: "talk.mp4", save: false });

    expect(saved.json.errors?.map((error) => error.error)).toEqual([expect.stringContaining("refused"), expect.stringContaining("refused")]);
    for (const text of [saved.text, links.text, logged.join("")]) {
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("\u001b");
    }
  });

  it("explains a download that stalled", async () => {
    const runner = runnerFor("clipsdk-output", new ClipSdk(api.baseUrl, GOOD_KEY, { idleMs: 1000, bytesPerSecond: 1 }));
    api.scenario.clips = 1;
    api.scenario.clip = (_index, file) => ({ title: "clip", video: file("video.mp4"), poster: null, srt: file("captions.srt"), vtt: null });
    api.scenario.onFile = (pathname, res) => {
      if (!pathname.endsWith("/captions.srt")) return false;
      res.writeHead(200, { "content-length": "10", "request-id": "req_stalled_file" }).write("x");
      return true;
    };

    const { json } = outcomeOf(await runner.start({ video_url: LINK }, "talk", true, context()));

    expect(json.clips?.[0]).toMatchObject({ video: output("talk", "01-clip.mp4"), srt: null });
    expect(json.errors?.[0]?.error).toBe(
      "download failed: no data for 1 s\nThe connection stalled or was too slow. The file stays on clipsdk for 7 days: download it from its url.\nRequest-Id: req_stalled_file",
    );
  });

  it("caps the size of all of a job's files together", async () => {
    const runner = runnerFor("clipsdk-output", new ClipSdk(api.baseUrl, GOOD_KEY, { outputBytes: 1000 }));
    api.scenario.clips = 1;
    api.scenario.clip = (_index, file) => ({ title: "clip", video: file("video.mp4"), poster: file("poster.jpg"), srt: null, vtt: null });
    api.scenario.onFile = (_pathname, res) => {
      res.end("x".repeat(600));
      return true;
    };

    const { json } = outcomeOf(await runner.start({ video_url: LINK }, "talk", true, context()));

    expect([json.clips?.[0]?.video, json.clips?.[0]?.poster].filter(Boolean)).toHaveLength(1);
    expect(JSON.stringify(json.errors)).toContain("more than a clipsdk job makes");
  });
});
