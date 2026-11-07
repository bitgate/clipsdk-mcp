import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, displayUrl, NetworkError, type Clip, type Job } from "./api.js";
import { elapsedSeconds, type FileKind, type SavedFile, type SavedJob, type ToolContext } from "./context.js";
import { errorMessage, log } from "./log.js";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const KEYS_PAGE = "https://clipsdk.com/dashboard/keys";
const BILLING_PAGE = "https://clipsdk.com/dashboard/billing";
const RETRY = "It's safe to call create_clips again, and a failed job costs nothing.";

const HINTS: Record<string, string> = {
  INVALID_REQUEST: "Fix the fields listed above and call the tool again.",
  UNAUTHORIZED: `The API key was rejected. Check CLIPSDK_KEY in this MCP server's config (csdk_live_ followed by 32 letters and digits, from ${KEYS_PAGE}) and restart the server.`,
  IDEMPOTENCY_CONFLICT: "clipsdk is still working on an earlier attempt of this request. Wait a minute, then try again.",
  INPUT_FETCH_FAILED: "clipsdk couldn't download the video. Pass a direct, public link to the file itself (not a page that plays it), or the local file path so it gets uploaded.",
  INPUT_UNSUPPORTED: "clipsdk couldn't read the video. Re-encode it as H.264/AAC MP4 (ffmpeg -i in.mov -c:v libx264 -c:a aac out.mp4) and try again.",
  INPUT_TOO_LONG: "Videos can be up to 3 hours. Cut it into parts first (ffmpeg -i in.mp4 -t 3:00:00 -c copy part1.mp4) and clip each part.",
  INPUT_TOO_SHORT: "The video is shorter than min_seconds. Lower min_seconds (10 at least) or use a longer video.",
  INPUT_TOO_LARGE: "The message says what's too big: over 5 GB, or too heavy to render clips this long, with the max_seconds that fits. Lower max_seconds, or re-encode the video smaller.",
  INPUT_CHANGED: "The file behind the link changed while clipsdk was reading it. Pass the local file path (it gets uploaded) or try again once the link is stable.",
  NO_SPEECH: "clipsdk picks moments from what people say, and it heard no speech in this video.",
  INSUFFICIENT_CREDIT: `The video costs more than the account's credit. Top up at ${BILLING_PAGE}, then call create_clips again.`,
  TIMEOUT: "The video took longer than its processing limit; the message says how far it got and what to change.",
  JOB_EXPIRED: `The job ran past its 12 h limit on clipsdk's side. ${RETRY}`,
  INTERNAL: `This failed on clipsdk's side. ${RETRY}`,
  DOWNLOAD_TIMEOUT: "The connection stalled or was too slow. The file stays on clipsdk for 7 days: download it from its url.",
  TOO_MANY_CLIPS: "Get this job from the clipsdk API directly for all of its links.",
  UPLOAD_FAILED: "Uploading the file to clipsdk's storage failed. Try again.",
  UPLOAD_STALLED: "The upload stalled. Check the connection and try again.",
  UPLOAD_EXPIRED: "The upload took longer than its upload link lasts (1 h). Try again on a faster connection, or pass a direct link to the file instead.",
};

// These failures count against the account: 30 an hour, or too much compute spent on failures in a day, and new jobs get 429
const COUNTED = new Set(["INPUT_FETCH_FAILED", "INPUT_UNSUPPORTED", "INPUT_TOO_LONG", "INPUT_TOO_SHORT", "INPUT_TOO_LARGE", "INPUT_CHANGED", "NO_SPEECH", "INSUFFICIENT_CREDIT", "TIMEOUT"]);

const SERVER_HINT = "This failed on clipsdk's side. Try again; if it keeps failing, report the Request-Id.";

function hintFor(error: ApiError): string | undefined {
  if (error.code === "NOT_FOUND") {
    return error.endpoint.startsWith("/v1/jobs/") ? "No job with that id for this API key: a job is only visible to the key that created it." : undefined;
  }
  if (error.status === 429) {
    const wait = error.retryAfterS === undefined ? "" : ` Try again in ${waitText(error.retryAfterS)}.`;
    return `That's an account limit: 3 jobs running at once, 200 jobs and 20 GB of uploads per UTC day, and a cap on failed jobs.${wait} A job that's running can be awaited with get_job.`;
  }
  return HINTS[error.code] ?? (error.status >= 500 ? SERVER_HINT : undefined);
}

export function textResult(summary: string, details: Record<string, unknown>, isError = false): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: `${summary}\n${JSON.stringify(details, null, 2)}` }];
  return isError ? { content, isError } : { content };
}

export function savedResult(job: Job, saved: SavedJob, ctx: ToolContext): CallToolResult {
  const clips = job.result?.clips ?? [];
  if (clips.length === 0) return clipsResult(job, ctx, "", undefined, {});

  // When the folder itself failed, every file carries that one reason, and it's said once
  const failed = saved.files.filter((file) => file.error);
  const errors = failed.some((file) => file.error !== saved.error) ? failed.map(({ clip, kind, url, error }) => ({ clip, file: kind, url, error })) : undefined;

  if (!saved.folder) {
    const reason = saved.error ?? "nothing was saved";
    return clipsResult(job, ctx, `Done: ${clips.length} clip(s), but they couldn't be saved here (${firstLine(reason)}). Their links below work for 7 days.`, undefined, {
      save_error: reason,
      errors,
    });
  }

  const best = saved.files.find((file) => file.clip === 1 && file.kind === "video" && file.path);
  let summary = `Done: ${clips.length} clip(s) saved in ${saved.folder}`;
  if (best?.path) summary += `, best first: ${best.path}${clips[0]?.score === null || clips[0] === undefined ? "" : ` (score ${clips[0].score})`}`;
  summary += failed.length > 0 ? `. ${failed.length} file(s) failed to download, see errors.` : ".";

  return clipsResult(job, ctx, summary, saved.files, { folder: saved.folder, errors });
}

export function linksResult(job: Job, ctx: ToolContext): CallToolResult {
  const count = job.result?.clips.length ?? 0;
  return clipsResult(job, ctx, `Done: ${count} clip(s), not downloaded. The links below work for 7 days and need no key.`, undefined, {});
}

function clipsResult(job: Job, ctx: ToolContext, summary: string, files: SavedFile[] | undefined, extra: Record<string, unknown>): CallToolResult {
  const clips = job.result?.clips ?? [];
  const text = clips.length === 0 ? "Done, but clipsdk found no moments in this video that work on their own as clips." : summary;
  return textResult(text, {
    status: "succeeded",
    job_id: job.id,
    ...extra,
    clips: clips.map((clip, index) => clipEntry(clip, index + 1, files)),
    source: job.result?.source ?? undefined,
    usage: job.usage,
    pricing: job.pricing ?? undefined,
    elapsed_s: elapsedSeconds(ctx),
  });
}

// With files, each link becomes where it was saved, or null when its download failed; without, it stays the link
function clipEntry(clip: Clip, number: number, files: SavedFile[] | undefined): Record<string, unknown> {
  const at = (kind: FileKind): string | null => {
    const url = clip[kind];
    if (url === null) return null;
    if (files === undefined) return displayUrl(url);
    return files.find((file) => file.clip === number && file.kind === kind)?.path ?? null;
  };
  return {
    rank: clip.rank,
    score: clip.score,
    title: clip.title,
    reason: clip.reason,
    start_s: clip.start_s,
    end_s: clip.end_s,
    duration_s: clip.duration_s,
    post_caption: clip.post_caption,
    video: at("video"),
    poster: at("poster"),
    srt: at("srt"),
    vtt: at("vtt"),
  };
}

export function runningResult(job: Job, ctx: ToolContext): CallToolResult {
  const stage = job.stage ? ` (${job.stage})` : "";
  const age = jobAge(job);
  return textResult(
    `Job ${job.id} is still ${job.status}${stage}${age === undefined ? "" : `, started ${age} s ago`}. Call get_job with job_id "${job.id}" to keep waiting; it saves the clips when the job is done.`,
    { status: job.status, job_id: job.id, stage: job.stage ?? undefined, elapsed_s: elapsedSeconds(ctx) },
  );
}

export function uploadingResult(file: string, sent: number, size: number, again: string, ctx: ToolContext): CallToolResult {
  const share = size > 0 ? Math.floor((sent / size) * 100) : 0;
  return textResult(
    `Still uploading ${file}: ${share}% sent. The upload keeps going in the background; ${again} to keep waiting, nothing gets uploaded or started twice.`,
    { status: "uploading", file, sent_bytes: sent, size_bytes: size, elapsed_s: elapsedSeconds(ctx) },
  );
}

export function jobAge(job: Job): number | undefined {
  const created = Date.parse(job.created_at ?? "");
  return Number.isFinite(created) ? Math.max(0, Math.round((Date.now() - created) / 1000)) : undefined;
}

export function failedResult(job: Job): CallToolResult {
  const code = job.error?.code ?? "INTERNAL";
  const counted = COUNTED.has(code);
  const hint = [HINTS[code] ?? SERVER_HINT, counted ? "Failures like this count toward the account's failed-job limit, so fix the input before trying again." : ""].filter(Boolean).join(" ");
  return textResult(`Job ${job.id} failed: ${code}: ${job.error?.message ?? "no details"}`, { status: "failed", job_id: job.id, error: job.error, hint }, true);
}

export function fileError(error: unknown): string {
  const lines = [`download failed: ${errorMessage(error)}`];
  if (error instanceof ApiError) {
    const hint = HINTS[error.code];
    if (hint) lines.push(hint);
    if (error.requestId) lines.push(`Request-Id: ${error.requestId}`);
  }
  return lines.join("\n");
}

export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: describeError(error) }], isError: true };
}

function describeError(error: unknown): string {
  if (error instanceof ToolError) return error.message;

  if (error instanceof ApiError) {
    const lines = [
      error.status === 0
        ? `clipsdk-mcp refused clipsdk's answer (${error.code}): ${error.message}`
        : error.issues.length > 0
          ? `clipsdk rejected the request (HTTP ${error.status} ${error.code}):`
          : `clipsdk returned HTTP ${error.status} ${error.code}: ${error.message}`,
      ...error.issues.map((issue) => `- ${issue.path || "body"}: ${issue.message}`),
    ];
    const hint = hintFor(error);
    if (hint) lines.push(hint);
    if (error.requestId) lines.push(`Request-Id: ${error.requestId}`);
    return lines.join("\n");
  }

  if (error instanceof NetworkError) return `${error.message}. Check the network connection and CLIPSDK_BASE_URL, then try again.`;
  if (error instanceof Error && error.name === "AbortError") return "Cancelled.";

  log("unexpected error", error);
  return `Unexpected error in clipsdk-mcp: ${errorMessage(error)}`;
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} s`;
  if (seconds < 2 * 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.round((seconds / 3600) * 10) / 10} h`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
