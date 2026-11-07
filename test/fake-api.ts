import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const GOOD_KEY = "csdk_live_0123456789abcdefghijABCDEFGHIJkl";

type Body = Record<string, unknown>;
type JobStatus = "running" | "succeeded" | "failed";

interface FakeJob {
  id: string;
  body: Body;
  polls: number;
}

interface Ticket {
  filename: string;
  size: number;
  key: string;
}

export interface Scenario {
  pollsUntilDone: number;
  failGets: number;
  createError?: { status: number; body: Body; headers?: Record<string, string> };
  failJob?: { code: string; message: string };
  clips?: number;
  clip?: (index: number, file: (name: string) => string) => Body;
  finished?: Body;
  failPuts?: number;
  holdPuts?: Promise<void>;
  onFile?: (pathname: string, res: ServerResponse) => Promise<boolean | void> | boolean | void;
}

export interface FakeApi {
  baseUrl: string;
  scenario: Scenario;
  requests: string[];
  tickets: { filename: string; size: number; video_url: string }[];
  uploads: { filename: string; size: number; bytes: number; authorization?: string }[];
  droppedPuts: number;
  created: { body: Body; key?: string }[];
  downloads: { path: string; query: string; authorization?: string }[];
  close(): Promise<void>;
}

export async function startFakeApi(): Promise<FakeApi> {
  const jobs = new Map<string, FakeJob>();
  const byKey = new Map<string, FakeJob>();
  const tickets = new Map<string, Ticket>();
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => send(res, 500, { error: { code: "INTERNAL", message: String(error) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const api: FakeApi = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    scenario: { pollsUntilDone: 1, failGets: 0 },
    requests: [],
    tickets: [],
    uploads: [],
    droppedPuts: 0,
    created: [],
    downloads: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", api.baseUrl);
    const body = await readBody(req);
    api.requests.push(`${req.method} ${url.pathname}`);

    if (url.pathname.startsWith("/f/")) {
      api.downloads.push({ path: url.pathname, query: url.search, authorization: req.headers.authorization });
      if (await api.scenario.onFile?.(url.pathname, res)) return;
      return send(res, 200, `bytes of ${url.pathname}`);
    }

    // Storage takes a PUT of exactly the size the ticket signed, and nothing else
    if (url.pathname.startsWith("/storage/")) {
      const ticket = tickets.get(url.searchParams.get("X-Amz-Signature") ?? "");
      if (req.method !== "PUT" || !ticket) return storageError(res, 403, "AccessDenied", "Access Denied");
      if (Number(req.headers["content-length"]) !== ticket.size || body.length !== ticket.size) {
        return storageError(res, 403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.");
      }
      let gone = false;
      res.on("close", () => {
        if (res.writableFinished) return;
        gone = true;
        api.droppedPuts += 1;
      });
      await api.scenario.holdPuts;
      if (gone) return;
      if ((api.scenario.failPuts ?? 0) > 0) {
        api.scenario.failPuts! -= 1;
        return storageError(res, 503, "ServiceUnavailable", "Please try again.");
      }
      api.uploads.push({ filename: ticket.filename, size: ticket.size, bytes: body.length, authorization: req.headers.authorization });
      res.writeHead(200, { etag: '"abc"' }).end();
      return;
    }

    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(res, 401, { error: { code: "UNAUTHORIZED", message: "invalid API key" } });

    if (req.method === "POST" && url.pathname === "/v1/uploads") {
      const { filename, size } = JSON.parse(body.toString("utf8")) as { filename: string; size: number };
      if (!/\.(mp4|mov|webm|mkv)$/i.test(filename)) return send(res, 400, { error: { code: "INVALID_REQUEST", message: "filename must end in .mp4, .mov, .webm or .mkv" } });

      const signature = token(32);
      const key = `in/${token(16)}/${filename}`;
      const videoUrl = `${api.baseUrl}/f/${key}`;
      tickets.set(signature, { filename, size, key });
      api.tickets.push({ filename, size, video_url: videoUrl });
      return send(res, 201, {
        upload_url: `${api.baseUrl}/storage/${key}?X-Amz-Expires=3600&X-Amz-Signature=${signature}`,
        video_url: videoUrl,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/clips") {
      const { createError } = api.scenario;
      if (createError) return send(res, createError.status, createError.body, createError.headers);

      const key = req.headers["idempotency-key"] as string | undefined;
      const replayed = key === undefined ? undefined : byKey.get(key);
      if (replayed) return send(res, 202, { job: view(replayed, "running") });

      const job: FakeJob = { id: `job_${token(20)}`, body: JSON.parse(body.toString("utf8")) as Body, polls: 0 };
      jobs.set(job.id, job);
      if (key !== undefined) byKey.set(key, job);
      api.created.push({ body: job.body, key });
      return send(res, 202, { job: view(job, "running") });
    }

    const job = jobs.get(/^\/v1\/jobs\/(job_[a-z0-9]{20})$/.exec(url.pathname)?.[1] ?? "");
    if (req.method === "GET" && job) {
      if (api.scenario.failGets > 0) {
        api.scenario.failGets -= 1;
        return send(res, 503, "upstream unavailable");
      }

      job.polls += 1;
      if (job.polls < api.scenario.pollsUntilDone) return send(res, 202, { job: view(job, "running") });
      return send(res, 200, { job: view(job, api.scenario.failJob ? "failed" : "succeeded") });
    }

    send(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
  }

  function view(job: FakeJob, status: JobStatus): Body {
    const done = status === "succeeded";
    const clips = done ? clipsFor(job) : [];
    return {
      id: job.id,
      op: "clips",
      status,
      stage: status === "running" ? "transcribing" : null,
      created_at: new Date().toISOString(),
      finished_at: status === "running" ? null : new Date().toISOString(),
      result: done ? { source: { duration_s: 600, language: "en", speakers: null }, clips } : null,
      usage: done ? { source_minutes: 10, clips: clips.length, output_seconds: 30 * clips.length } : { source_minutes: 0, clips: 0, output_seconds: 0 },
      pricing: null,
      error: status === "failed" ? (api.scenario.failJob ?? null) : null,
      poll_url: `${api.baseUrl}/v1/jobs/${job.id}`,
      ...(done ? api.scenario.finished : undefined),
    };
  }

  function clipsFor(job: FakeJob): Body[] {
    const count = api.scenario.clips ?? 2;
    return Array.from({ length: count }, (_, index) => {
      const file = (name: string) => `${api.baseUrl}/f/out/${job.id}/${index}/${name}?s=sig${index}`;
      if (api.scenario.clip) return api.scenario.clip(index, file);
      return {
        rank: index + 1,
        score: 90 - index * 10,
        title: index === 0 ? "Why pricing pages fail" : `Moment ${index + 1}`,
        reason: "clear hook and payoff",
        start_s: 60 * index + 12.5,
        end_s: 60 * index + 42.5,
        duration_s: 30,
        transcript: "so here's the thing about pricing",
        post_caption: "Your pricing page is lying to you",
        video: file("video.mp4"),
        poster: file("poster.jpg"),
        srt: file("captions.srt"),
        vtt: file("captions.vtt"),
      };
    });
  }

  return api;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: Body | string, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json", "request-id": `req_${token(16)}`, ...headers });
  res.end(text);
}

function storageError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "content-type": "application/xml" }).end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
}

function token(length: number): string {
  return Array.from(randomBytes(length), (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
}
