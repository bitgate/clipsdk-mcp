import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage, log } from "./log.js";
import { saveExclusive } from "./paths.js";
import { VERSION } from "./version.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Clip {
  rank: number;
  score: number | null;
  title: string;
  reason: string;
  start_s: number | null;
  end_s: number | null;
  duration_s: number | null;
  transcript: string;
  post_caption: string;
  video: string;
  poster: string | null;
  srt: string | null;
  vtt: string | null;
}

export interface ClipsResult {
  source: { duration_s?: number; language?: string | null; speakers?: number | null } | null;
  clips: Clip[];
}

export interface Job {
  id: string;
  op: string;
  status: JobStatus;
  stage?: string | null;
  created_at?: string;
  finished_at?: string | null;
  result: ClipsResult | null;
  usage?: Record<string, number>;
  pricing?: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  poll_url?: string;
}

export interface ClipsRequest {
  video_url: string;
  clips?: number;
  min_seconds?: number;
  max_seconds?: number;
  aspect?: string;
  reframe?: string;
  captions?: string | false;
  language?: string;
  prompt?: string;
  webhook_url?: string;
}

export interface UploadTicket {
  upload_url: string;
  video_url: string;
  expires_at: string;
}

export interface Issue {
  path: string;
  message: string;
}

export interface ErrorDetails {
  issues?: Issue[];
  retryAfterS?: number;
  requestId?: string;
  retryable?: boolean;
}

export class ApiError extends Error {
  readonly issues: Issue[];
  readonly retryAfterS: number | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean | undefined;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly endpoint: string,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.issues = details.issues ?? [];
    this.retryAfterS = details.retryAfterS;
    this.requestId = details.requestId;
    this.retryable = details.retryable;
  }
}

export class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export interface Limits {
  outputBytes: number;
  answerBytes: number;
  idleMs: number;
  bytesPerSecond: number;
}

export interface OutputBudget {
  left: number;
}

export interface UploadFile {
  handle: FileHandle;
  size: number;
}

export const MAX_CLIPS = 20;

const MAX_ATTEMPTS = 4;
const MAX_REDIRECTS = 3;
const MAX_RETRY_AFTER_S = 20;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const REQUEST_ID = /^[\w-]{1,128}$/;
const MAX_TIMER_MS = 2 ** 31 - 1;
const USER_AGENT = `clipsdk-mcp/${VERSION} node/${process.versions.node}`;

// clipsdk takes a minute to give up on a first attempt that never made anything, and until then a repeat hears 409
const STILL_PROCESSING_MS = 75_000;

// A PUT that would start this close to its URL's expiry asks for a new ticket instead
const TICKET_MARGIN_MS = 60_000;

// 20 clips of 90 s at 1080p stay well under 8 GiB, and none of clipsdk's JSON answers comes near 8 MiB.
// A transfer may go quiet for a minute, and a download gets as long as its size takes at 64 KiB/s on top of that
const LIMITS: Limits = { outputBytes: 8 * 1024 ** 3, answerBytes: 8 * 1024 ** 2, idleMs: 60_000, bytesPerSecond: 64 * 1024 };

interface Call {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number>;
  json?: unknown;
  idempotencyKey?: string;
  retryIf?: (error: unknown) => boolean;
  signal: AbortSignal;
  timeoutMs: number;
}

interface Answer {
  data: Body | null;
  requestId: string | undefined;
}

type Body = Record<string, unknown>;

export class ClipSdk {
  readonly #limits: Limits;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    limits: Partial<Limits> = {},
  ) {
    this.#limits = { ...LIMITS, ...limits };
  }

  // wait=0 returns the job id at once; the long waits happen on GET. Every attempt of one call carries the same
  // Idempotency-Key, so a repeat after a lost answer gets the first attempt's job instead of starting a second one
  async createClips(request: ClipsRequest, signal: AbortSignal): Promise<Job> {
    const path = "/v1/clips";
    const call: Call = { method: "POST", path, query: { wait: 0 }, json: request, idempotencyKey: randomUUID(), retryIf: repeatable, signal, timeoutMs: 60_000 };
    return jobFrom(await this.#call(call), path);
  }

  async getJob(id: string, waitS: number, signal: AbortSignal): Promise<Job> {
    const path = `/v1/jobs/${encodeURIComponent(id)}`;
    return jobFrom(await this.#call({ method: "GET", path, query: { wait: waitS }, signal, timeoutMs: (waitS + 30) * 1000 }), path);
  }

  async createUpload(filename: string, size: number, signal: AbortSignal): Promise<UploadTicket> {
    const path = "/v1/uploads";
    const call: Call = { method: "POST", path, json: { filename, size }, idempotencyKey: randomUUID(), retryIf: repeatable, signal, timeoutMs: 60_000 };
    const { data, requestId } = await this.#call(call);
    if (!isTicket(data)) throw badResponse("the upload ticket has no upload_url and video_url", path, requestId);
    return { upload_url: data.upload_url, video_url: data.video_url, expires_at: data.expires_at };
  }

  // The bytes go straight to storage. Its URL carries its own signature, so the key never goes along, and the
  // signed Content-Length means storage takes exactly the bytes we checked. Every attempt re-reads the file from the start
  async putUpload(ticket: UploadTicket, file: UploadFile, signal: AbortSignal, onSent: (bytes: number) => void = () => {}): Promise<void> {
    const target = this.#uploadTarget(ticket.upload_url);
    const shown = `${target.origin}${target.pathname}`;
    const expiresAt = Date.parse(ticket.expires_at);
    const { idleMs } = this.#limits;

    await this.#retrying(`PUT ${shown}`, target.origin, signal, retryable, async () => {
      if (Date.now() > expiresAt - TICKET_MARGIN_MS) throw refused("UPLOAD_EXPIRED", "the upload URL expired before the file got there", shown, undefined);

      const idle = new AbortController();
      const idleTimer = setTimeout(() => idle.abort(new ApiError(504, "UPLOAD_STALLED", `the upload stalled for ${idleMs / 1000} s`, shown, { retryable: true })), idleMs);
      let sent = 0;
      const progress = (bytes: number) => {
        idleTimer.refresh();
        sent += bytes;
        onSent(sent);
      };

      try {
        const response = await fetch(target, {
          method: "PUT",
          headers: { "content-length": String(file.size), "user-agent": USER_AGENT },
          body: fileChunks(file, progress),
          duplex: "half",
          redirect: "manual",
          signal: AbortSignal.any([signal, idle.signal]),
        });
        const text = await answerText(response, this.#limits.answerBytes, shown, undefined);
        if (!response.ok) throw storageError(response, text, shown);
      } catch (error) {
        throw idle.signal.aborted ? idle.signal.reason : error;
      } finally {
        clearTimeout(idleTimer);
      }
    });
  }

  outputBudget(): OutputBudget {
    return { left: this.#limits.outputBytes };
  }

  // A download may go quiet for idleMs, and gets idleMs plus its size at bytesPerSecond in all, retries included
  async download(url: string, destination: string, signal: AbortSignal, budget: OutputBudget): Promise<number> {
    const shown = displayUrl(url);
    const { idleMs, bytesPerSecond } = this.#limits;

    let requestId: string | undefined;
    const tooLarge = () => new ApiError(413, "OUTPUT_TOO_LARGE", `the job's files are over ${sizeOf(this.#limits.outputBytes)}, more than a clipsdk job makes`, shown, { requestId });
    const timedOut = (reason: string) => new ApiError(504, "DOWNLOAD_TIMEOUT", reason, shown, { requestId, retryable: false });

    const started = Date.now();
    const overall = new AbortController();
    const stopped = AbortSignal.any([signal, overall.signal]);
    let overallTimer: NodeJS.Timeout | undefined;

    const attempt = async (): Promise<number> => {
      const idle = new AbortController();
      const idleTimer = setTimeout(() => idle.abort(timedOut(`no data for ${idleMs / 1000} s`)), idleMs);
      try {
        const response = await this.#fetchOutput(url, AbortSignal.any([stopped, idle.signal]));
        requestId = requestIdOf(response.headers.get("request-id"));
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new ApiError(response.status, `HTTP_${response.status}`, `download failed with HTTP ${response.status}`, shown, { requestId });
        }

        const size = declaredSize(response) ?? budget.left;
        if (size > budget.left) {
          await response.body.cancel();
          throw tooLarge();
        }

        // Node fires a timer longer than MAX_TIMER_MS at once
        const allowedMs = idleMs + (size / bytesPerSecond) * 1000;
        const stop = () => overall.abort(timedOut(`not done after ${Math.round(allowedMs / 1000)} s`));
        overallTimer ??= setTimeout(stop, Math.min(started + allowedMs - Date.now(), MAX_TIMER_MS));

        // We count every byte against the job's budget, whatever Content-Length said, and get them back once a failed attempt's file is gone
        let bytes = 0;
        async function* counted(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
          for await (const chunk of body) {
            idleTimer.refresh();
            bytes += chunk.byteLength;
            budget.left -= chunk.byteLength;
            if (budget.left < 0) throw tooLarge();
            yield chunk;
          }
        }

        await saveExclusive(counted(response.body), destination, () => (budget.left += bytes));
        return bytes;
      } catch (error) {
        throw idle.signal.aborted ? idle.signal.reason : error;
      } finally {
        clearTimeout(idleTimer);
      }
    };

    try {
      return await this.#retrying(`GET ${shown}`, this.baseUrl, stopped, retryable, attempt);
    } catch (error) {
      throw overall.signal.aborted ? overall.signal.reason : error;
    } finally {
      clearTimeout(overallTimer);
    }
  }

  // Files only come from the API's own /f/ links, every redirect hop is held to the same rule, and the key is never sent along
  async #fetchOutput(url: string, signal: AbortSignal): Promise<Response> {
    let next = url;
    for (let hops = 0; ; hops++) {
      if (!this.#isOutputUrl(next)) throw new Error(`refused ${displayUrl(next)}: files only download from ${this.baseUrl}/f/`);

      const response = await fetch(next, { headers: { "user-agent": USER_AGENT }, redirect: "manual", signal });
      const location = response.headers.get("location");
      if (!REDIRECT_STATUS.has(response.status) || location === null) return response;

      await response.body?.cancel();
      if (hops === MAX_REDIRECTS) throw new Error(`refused ${displayUrl(url)}: more than ${MAX_REDIRECTS} redirects`);
      next = new URL(location, next).href;
    }
  }

  #isOutputUrl(url: string): boolean {
    if (!URL.canParse(url)) return false;

    const target = new URL(url);
    const base = new URL(this.baseUrl);
    return target.origin === base.origin && !target.username && !target.password && target.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/f/`);
  }

  // Local bytes only ever go to an https URL, or to the API's own host when that is this machine
  #uploadTarget(url: string): URL {
    const target = URL.canParse(url) ? new URL(url) : undefined;
    const safe = target !== undefined && !target.username && !target.password && (target.protocol === "https:" || target.origin === new URL(this.baseUrl).origin);
    if (!safe) throw refused("BAD_UPLOAD_URL", "the upload ticket's upload_url is not an https link", "/v1/uploads", undefined);
    return target;
  }

  async #call(call: Call): Promise<Answer> {
    const query = new URLSearchParams(Object.entries(call.query ?? {}).map(([key, value]): [string, string] => [key, String(value)]));
    const url = `${this.baseUrl}${call.path}${query.size > 0 ? `?${query}` : ""}`;

    return this.#retrying(`${call.method} ${call.path}`, this.baseUrl, call.signal, call.retryIf ?? retryable, async () => {
      const response = await fetch(url, {
        method: call.method,
        headers: this.#headers(call),
        body: call.json === undefined ? undefined : JSON.stringify(call.json),
        redirect: "manual",
        signal: withTimeout(call.signal, call.timeoutMs),
      });

      const headerId = requestIdOf(response.headers.get("request-id"));
      const text = await answerText(response, this.#limits.answerBytes, call.path, headerId);
      const data = parseObject(text);
      const requestId = headerId ?? requestIdOf((data?.error as Body | null | undefined)?.request_id);
      if (response.ok) return { data, requestId };

      throw apiError(response, data, text, call.path, requestId);
    });
  }

  #headers(call: Call): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (call.idempotencyKey !== undefined) headers["idempotency-key"] = call.idempotencyKey;
    if (call.json !== undefined) headers["content-type"] = "application/json";
    return headers;
  }

  async #retrying<T>(label: string, host: string, signal: AbortSignal, retryIf: (error: unknown) => boolean, attempt: () => Promise<T>): Promise<T> {
    const started = Date.now();
    for (let n = 1; ; n++) {
      try {
        return await attempt();
      } catch (error) {
        if (signal.aborted) throw error;

        // A long Retry-After is a limit that won't lift within this call, so it goes back to the caller as it is
        const patient = stillProcessing(error) && Date.now() - started < STILL_PROCESSING_MS;
        const longWait = error instanceof ApiError && (error.retryAfterS ?? 0) > MAX_RETRY_AFTER_S;
        if (!patient && (longWait || !retryIf(error) || n >= MAX_ATTEMPTS)) {
          if (error instanceof ApiError || !isNetworkFailure(error)) throw error;
          const lost = neverSent(error) ? "Couldn't reach" : "Lost the connection to";
          throw new NetworkError(`${lost} ${host} after ${n} attempt${n === 1 ? "" : "s"} (${errorMessage(error)})`, { cause: error });
        }

        const waitMs = error instanceof ApiError && error.retryAfterS !== undefined ? error.retryAfterS * 1000 + Math.random() * 250 : backoffMs(n);
        log(`${label} failed (${errorMessage(error)}), ${patient ? "asking again" : `retry ${n}/${MAX_ATTEMPTS - 1}`} in ${Math.round(waitMs)} ms`);
        await delay(waitMs, undefined, { signal });
      }
    }
  }
}

// Links from an answer are shown without credentials, and URL's own normalization escapes control characters
export function displayUrl(url: string): string {
  if (!URL.canParse(url)) return "(not a valid link)";

  const shown = new URL(url);
  shown.username = "";
  shown.password = "";
  return shown.href;
}

// We read through the handle we checked, never by the file's name, and report every chunk as it goes out
async function* fileChunks(file: UploadFile, onChunk: (bytes: number) => void): AsyncGenerator<Uint8Array> {
  for await (const chunk of file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false }) as AsyncIterable<Buffer>) {
    onChunk(chunk.byteLength);
    yield chunk;
  }
}

// We read at most maxBytes of an answer, whatever its Content-Length claims
async function answerText(response: Response, maxBytes: number, endpoint: string, requestId: string | undefined): Promise<string> {
  const tooLarge = () => refused("RESPONSE_TOO_LARGE", `the answer is over ${sizeOf(maxBytes)}`, endpoint, requestId);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function declaredSize(response: Response): number | undefined {
  const value = Number(response.headers.get("content-length") ?? Number.NaN);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sizeOf(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${bytes / 1024 ** 3} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
}

function retryable(error: unknown): boolean {
  if (error instanceof ApiError) return error.retryable ?? RETRYABLE_STATUS.has(error.status);
  return isNetworkFailure(error);
}

// A POST with an Idempotency-Key is safe to repeat whatever happened to the first attempt.
// A 429 is an account limit (jobs running, jobs per day, failures), so it goes back to the caller at once
function repeatable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status !== 429 && retryable(error);
  return isNetworkFailure(error);
}

function stillProcessing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT" && error.retryAfterS !== undefined;
}

function neverSent(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
  return NOT_CONNECTED.has(cause?.code ?? "");
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  if (error.name === "TypeError" && (error.cause !== undefined || error.message === "fetch failed" || error.message === "terminated")) return true;

  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^(ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR)/.test(code);
}

function parseObject(text: string): Body | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Body) : null;
  } catch {
    return null;
  }
}

function requestIdOf(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : undefined;
}

function isTicket(value: unknown): value is UploadTicket {
  const ticket = value as Partial<UploadTicket> | null;
  return typeof ticket?.upload_url === "string" && typeof ticket.video_url === "string" && typeof ticket.expires_at === "string";
}

const stringOr = (value: unknown): string => (typeof value === "string" ? value : "");
const numberOr = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const linkOr = (value: unknown): string | null => (typeof value === "string" ? value : null);

function jobFrom({ data, requestId }: Answer, endpoint: string): Job {
  const job = data?.job as Body | undefined;
  if (typeof job?.id !== "string" || typeof job.status !== "string") throw badResponse("the response has no job", endpoint, requestId);

  const error = typeof job.error === "object" && job.error !== null ? (job.error as Body) : null;
  const base = { ...(job as unknown as Job), error: error && { code: stringOr(error.code) || "INTERNAL", message: stringOr(error.message) } };
  if (job.status !== "succeeded") return { ...base, result: null };

  // A finished job must list its clips, each with a video link, and few enough that one answer can't fan out into thousands of downloads
  const result = (typeof job.result === "object" && job.result !== null ? job.result : {}) as Body;
  if (!Array.isArray(result.clips)) throw badResponse("the finished job has no list of clips", endpoint, requestId);
  if (result.clips.length > MAX_CLIPS) {
    throw refused("TOO_MANY_CLIPS", `the job lists ${result.clips.length} clips, and clipsdk-mcp saves at most ${MAX_CLIPS}`, endpoint, requestId);
  }

  const clips = result.clips.map((raw: unknown, index): Clip => {
    const clip = (typeof raw === "object" && raw !== null ? raw : {}) as Body;
    if (typeof clip.video !== "string") throw badResponse(`clip ${index + 1} has no video link`, endpoint, requestId);
    return {
      rank: Number.isSafeInteger(clip.rank) ? (clip.rank as number) : index + 1,
      score: numberOr(clip.score),
      title: stringOr(clip.title),
      reason: stringOr(clip.reason),
      start_s: numberOr(clip.start_s),
      end_s: numberOr(clip.end_s),
      duration_s: numberOr(clip.duration_s),
      transcript: stringOr(clip.transcript),
      post_caption: stringOr(clip.post_caption),
      video: clip.video,
      poster: linkOr(clip.poster),
      srt: linkOr(clip.srt),
      vtt: linkOr(clip.vtt),
    };
  });
  const source = typeof result.source === "object" && result.source !== null ? (result.source as ClipsResult["source"]) : null;
  return { ...base, result: { source, clips } };
}

function badResponse(message: string, endpoint: string, requestId: string | undefined): ApiError {
  return new ApiError(502, "BAD_RESPONSE", message, endpoint, { requestId });
}

// Status 0: clipsdk-mcp turned the answer down itself, so there is no HTTP status to show
function refused(code: string, message: string, endpoint: string, requestId: string | undefined): ApiError {
  return new ApiError(0, code, message, endpoint, { requestId });
}

function isIssue(value: unknown): value is Issue {
  return typeof value === "object" && value !== null && typeof (value as Issue).message === "string";
}

function apiError(response: Response, data: Body | null, text: string, endpoint: string, requestId: string | undefined): ApiError {
  const body = (typeof data?.error === "object" && data.error !== null ? data.error : {}) as Body;
  const code = typeof body.code === "string" ? body.code : `HTTP_${response.status}`;
  const snippet = text && !text.trimStart().startsWith("<") ? `: ${text.slice(0, 200)}` : "";
  const message = typeof body.message === "string" ? body.message : `HTTP ${response.status} ${response.statusText}${snippet}`;
  const issues = Array.isArray(body.issues) ? body.issues.filter(isIssue) : [];
  return new ApiError(response.status, code, message, endpoint, { issues, retryAfterS: retryAfter(response.headers.get("retry-after")), requestId });
}

// Storage answers in S3's XML: <Error><Code>SignatureDoesNotMatch</Code><Message>...</Message></Error>
function storageError(response: Response, text: string, endpoint: string): ApiError {
  const field = (name: string) => new RegExp(`<${name}>([^<]{1,200})</${name}>`).exec(text)?.[1];
  const code = field("Code");
  const message = field("Message") ?? `HTTP ${response.status} ${response.statusText}`;
  return new ApiError(response.status, "UPLOAD_FAILED", code ? `${code}: ${message}` : message, endpoint, { retryAfterS: retryAfter(response.headers.get("retry-after")) });
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}
