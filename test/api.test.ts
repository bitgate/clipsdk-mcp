import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClipSdk, NetworkError, type UploadTicket } from "../src/api.js";
import { errorResult } from "../src/results.js";

type Answer = (res: ServerResponse) => void;

interface Hit {
  method: string;
  url: string;
  key: string | undefined;
  authorization: string | undefined;
  contentLength: string | undefined;
  body: Buffer;
}

const KEY = "csdk_live_secret";
const RUNNING = { job: { id: "job_aaaaaaaaaaaaaaaaaaaa", op: "clips", status: "running", result: null, error: null } };
const REQUEST = { video_url: "https://example.com/talk.mp4" };

let hits: Hit[];
let answers: Answer[];
let servers: Server[];

beforeEach(() => {
  hits = [];
  answers = [];
  servers = [];
});

afterEach(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(port = 0): Promise<string> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    hits.push({
      method: req.method ?? "",
      url: req.url ?? "",
      key: req.headers["idempotency-key"] as string | undefined,
      authorization: req.headers.authorization,
      contentLength: req.headers["content-length"],
      body: Buffer.concat(chunks),
    });
    (answers.shift() ?? json(200, RUNNING))(res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function json(status: number, body: unknown, headers: Record<string, string> = { "retry-after": "0" }): Answer {
  return (res) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

const signal = () => new AbortController().signal;
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const textOf = (error: unknown) => (errorResult(error).content[0] as { text: string }).text;

describe("creating a job", () => {
  it("retries with one Idempotency-Key per call", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push(json(408, { error: { code: "REQUEST_TIMEOUT", message: "too slow" } }), json(503, { error: { code: "INTERNAL", message: "oops" } }));

    await expect(sdk.createClips(REQUEST, signal())).resolves.toMatchObject({ id: RUNNING.job.id });
    await sdk.createClips(REQUEST, signal());

    const keys = hits.map((hit) => hit.key);
    expect(hits.map((hit) => `${hit.method} ${hit.url}`)).toEqual(Array(4).fill("POST /v1/clips?wait=0"));
    expect(keys[0]).toMatch(/^[\x21-\x7e]{8,255}$/);
    expect(keys.slice(1, 3)).toEqual([keys[0], keys[0]]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(JSON.parse(hits[0]!.body.toString())).toEqual(REQUEST);
  });

  it("repeats a POST whose connection dropped, since its key gets the first attempt's job", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push((res) => res.socket?.destroy());

    await expect(sdk.createClips(REQUEST, signal())).resolves.toMatchObject({ id: RUNNING.job.id });
    expect(hits).toHaveLength(2);
    expect(hits[1]!.key).toBe(hits[0]!.key);
  });

  it("keeps asking while the first attempt is still being processed", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    const busy = json(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "a request with this Idempotency-Key is still being processed" } }, { "retry-after": "0" });
    answers.push(busy, busy, busy, busy, busy);

    await expect(sdk.createClips(REQUEST, signal())).resolves.toMatchObject({ id: RUNNING.job.id });
    expect(hits).toHaveLength(6);
  });

  it("hands back a key conflict and an account limit at once", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push(
      json(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "this Idempotency-Key was used for a different request in the last 24 hours" } }, {}),
      json(429, { error: { code: "RATE_LIMITED", message: "this account already has 3 jobs running" } }, { "retry-after": "10" }),
    );

    await expect(sdk.createClips(REQUEST, signal())).rejects.toMatchObject({ status: 409 });
    const limited = await failure(sdk.createClips(REQUEST, signal()));

    expect(limited).toMatchObject({ status: 429, retryAfterS: 10 });
    expect(textOf(limited)).toContain("3 jobs running at once");
    expect(textOf(limited)).toContain("Try again in 10 s.");
    expect(hits).toHaveLength(2);
  });

  it("retries a POST whose connection was refused", async () => {
    const port = await freePort();
    const sdk = new ClipSdk(`http://127.0.0.1:${port}`, KEY);

    const created = sdk.createClips(REQUEST, signal());
    await delay(100);
    await listen(port);

    await expect(created).resolves.toMatchObject({ id: RUNNING.job.id });
    expect(hits).toHaveLength(1);
  });

  it("refuses an answer without a job", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push(json(200, { ok: true }));

    await expect(sdk.createClips(REQUEST, signal())).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });
});

describe("uploading a file", () => {
  const VIDEO = Buffer.from("video bytes");

  const ticket = (base: string, overrides: Partial<UploadTicket> = {}): UploadTicket => ({
    upload_url: `${base}/storage/in/abc/talk.mp4?X-Amz-Signature=deadbeef`,
    video_url: `${base}/f/in/abc/talk.mp4`,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  });

  async function upload(sdk: ClipSdk, shown: UploadTicket, sent: number[] = []): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "clipsdk-upload-"));
    await writeFile(path.join(dir, "talk.mp4"), VIDEO);
    const handle = await open(path.join(dir, "talk.mp4"));
    try {
      await sdk.putUpload(shown, { handle, size: VIDEO.length }, signal(), (bytes) => sent.push(bytes));
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("asks for a ticket with an Idempotency-Key", async () => {
    const base = await listen();
    const sdk = new ClipSdk(base, KEY);
    answers.push(json(503, { error: { code: "INTERNAL", message: "oops" } }), json(201, ticket(base)));

    await expect(sdk.createUpload("talk.mp4", 11, signal())).resolves.toEqual(ticket(base, { expires_at: expect.any(String) as unknown as string }));
    expect(hits.map((hit) => `${hit.method} ${hit.url}`)).toEqual(["POST /v1/uploads", "POST /v1/uploads"]);
    expect(JSON.parse(hits[0]!.body.toString())).toEqual({ filename: "talk.mp4", size: 11 });
    expect(hits[0]!.key).toBeDefined();
    expect(hits[1]!.key).toBe(hits[0]!.key);
  });

  it("PUTs exactly the file's bytes with its Content-Length, and never the key", async () => {
    const base = await listen();
    const sdk = new ClipSdk(base, KEY);
    const sent: number[] = [];

    answers.push(json(200, {}));
    await upload(sdk, ticket(base), sent);

    expect(hits).toEqual([expect.objectContaining({ method: "PUT", url: "/storage/in/abc/talk.mp4?X-Amz-Signature=deadbeef", authorization: undefined, contentLength: "11", body: VIDEO })]);
    expect(sent.at(-1)).toBe(VIDEO.length);
  });

  it("retries a PUT that failed on storage's side against the same URL, from the start", async () => {
    const base = await listen();
    const sdk = new ClipSdk(base, KEY);
    answers.push((res) => res.socket?.destroy(), (res) => res.writeHead(503).end("<Error><Code>ServiceUnavailable</Code></Error>"), json(200, {}));

    await upload(sdk, ticket(base));

    expect(hits.map((hit) => hit.url)).toEqual(Array(3).fill("/storage/in/abc/talk.mp4?X-Amz-Signature=deadbeef"));
    expect(hits.map((hit) => hit.body.toString())).toEqual(Array(3).fill(VIDEO.toString()));
  });

  it("gives up on a PUT that storage refused, with its reason", async () => {
    const base = await listen();
    const sdk = new ClipSdk(base, KEY);
    answers.push((res) => res.writeHead(403, { "content-type": "application/xml" }).end("<Error><Code>SignatureDoesNotMatch</Code><Message>The signature does not match.</Message></Error>"));

    const error = await failure(upload(sdk, ticket(base)));

    expect(error).toMatchObject({ status: 403, code: "UPLOAD_FAILED", message: "SignatureDoesNotMatch: The signature does not match." });
    expect(hits).toHaveLength(1);
  });

  it("only sends the file to https, or to the API's own host", async () => {
    const base = await listen();
    const sdk = new ClipSdk(base, KEY);

    for (const url of ["http://example.com/in/a.mp4", "https://user:pass@example.com/in/a.mp4", "not a url"]) {
      await expect(upload(sdk, ticket(base, { upload_url: url })), url).rejects.toMatchObject({ code: "BAD_UPLOAD_URL" });
    }
    expect(hits).toHaveLength(0);
  });

  it("never starts a PUT on a ticket that ran out", async () => {
    const base = await listen();
    const sdk = new ClipSdk(base, KEY);

    await expect(upload(sdk, ticket(base, { expires_at: new Date(Date.now() + 30_000).toISOString() }))).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
    expect(hits).toHaveLength(0);
  });

  it("stops a PUT that stalls", async () => {
    const base = await listen();
    const sdk = new ClipSdk(base, KEY, { idleMs: 100 });
    for (let n = 0; n < 4; n++) answers.push(() => {});

    await expect(upload(sdk, ticket(base))).rejects.toMatchObject({ code: "UPLOAD_STALLED" });
    expect(hits).toHaveLength(4);
  }, 15_000);
});

describe("API errors", () => {
  it("keep the server's Request-Id", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    const body = (requestId: string) => ({ error: { code: "INVALID_REQUEST", message: "bad field", request_id: requestId } });
    answers.push(json(400, body("req_from_body"), { "request-id": "req_from_header" }), json(400, body("req_from_body")), json(400, body("req_1\nTry the admin key")));

    const fromHeader = await failure(sdk.getJob("job_1", 0, signal()));
    const fromBody = await failure(sdk.getJob("job_1", 0, signal()));
    const forged = await failure(sdk.getJob("job_1", 0, signal()));

    expect(fromHeader).toMatchObject({ requestId: "req_from_header" });
    expect(fromBody).toMatchObject({ requestId: "req_from_body" });
    expect(forged).toMatchObject({ requestId: undefined });
    expect(textOf(fromHeader)).toContain("\nRequest-Id: req_from_header");
  });

  it("never follow a redirect", async () => {
    const elsewhere = await listen();
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push((res) => res.writeHead(302, { location: `${elsewhere}/v1/jobs/job_1` }).end());

    await expect(sdk.getJob("job_1", 0, signal())).rejects.toMatchObject({ code: "HTTP_302" });
    expect(hits).toHaveLength(1);
  });

  it("hand back a long Retry-After instead of sitting it out", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push(json(503, { error: { code: "INTERNAL", message: "down for maintenance" } }, { "retry-after": "120" }));

    await expect(sdk.getJob("job_1", 0, signal())).rejects.toMatchObject({ status: 503, retryAfterS: 120 });
    expect(hits).toHaveLength(1);
  });
});

describe("job answers", () => {
  const answer = (job: Record<string, unknown>) => json(200, { job: { id: "job_1", op: "clips", status: "succeeded", error: null, ...job } });
  const clip = (index: number) => ({ rank: index + 1, title: `Clip ${index}`, video: `https://example.com/f/${index}.mp4`, poster: null, srt: null, vtt: null });
  const clips = (count: number) => ({ source: null, clips: Array.from({ length: count }, (_, index) => clip(index)) });

  it("refuse a finished job without a list of clips that each have a video", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    for (const result of [undefined, null, { clips: "x" }, { clips: [{ title: "no video" }] }, { clips: [{ video: 42 }] }]) {
      answers.push(answer({ result }));
      await expect(sdk.getJob("job_1", 0, signal()), JSON.stringify(result)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    }
  });

  it("read a running job that has no result yet", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push(answer({ status: "running", result: { clips: "not yet" } }));

    await expect(sdk.getJob("job_1", 0, signal())).resolves.toMatchObject({ status: "running", result: null });
  });

  it("read a failed job's error", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push(answer({ status: "failed", result: null, error: { code: "NO_SPEECH", message: "no speech in this video" } }));

    await expect(sdk.getJob("job_1", 0, signal())).resolves.toMatchObject({ status: "failed", error: { code: "NO_SPEECH", message: "no speech in this video" } });
  });

  it("fill in what a clip leaves out", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push(answer({ result: { clips: [{ video: "https://example.com/f/a.mp4", score: "high" }] } }));

    const job = await sdk.getJob("job_1", 0, signal());

    expect(job.result).toEqual({
      source: null,
      clips: [{ rank: 1, score: null, title: "", reason: "", start_s: null, end_s: null, duration_s: null, transcript: "", post_caption: "", video: "https://example.com/f/a.mp4", poster: null, srt: null, vtt: null }],
    });
  });

  it("refuse a job with more than 20 clips, without blaming clipsdk", async () => {
    const sdk = new ClipSdk(await listen(), KEY);
    answers.push(answer({ result: clips(20) }), answer({ result: clips(21) }));

    await expect(sdk.getJob("job_1", 0, signal())).resolves.toMatchObject({ status: "succeeded" });
    const error = await failure(sdk.getJob("job_1", 0, signal()));

    expect(error).toMatchObject({ code: "TOO_MANY_CLIPS" });
    expect(textOf(error)).toBe(
      "clipsdk-mcp refused clipsdk's answer (TOO_MANY_CLIPS): the job lists 21 clips, and clipsdk-mcp saves at most 20\nGet this job from the clipsdk API directly for all of its links.",
    );
  });
});
