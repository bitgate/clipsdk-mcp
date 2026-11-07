import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { ToolContext } from "./context.js";
import { safeName, type JobRunner } from "./jobs.js";
import { log } from "./log.js";
import { StillUploading, type Media } from "./media.js";
import { errorResult, textResult, ToolError, uploadingResult } from "./results.js";

export interface Services {
  media: Media;
  jobs: JobRunner;
}

export interface ToolSettings {
  outputDir: string;
  waitSeconds: number;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Work = (ctx: ToolContext, services: Services) => Promise<CallToolResult>;

const DEFAULT_MIN_S = 20;
const DEFAULT_MAX_S = 60;
const MAX_CLIP_S = 90;
const MIN_WINDOW_S = 5;
const LANGUAGE = /^[a-zA-Z]{2}([-_][a-zA-Z0-9]{2,8})?$/;
const JOB_ID = /^job_[a-z0-9]{20}$/;

export function registerTools(server: McpServer, services: () => Services, settings: ToolSettings): void {
  const tool = (name: string, extra: Extra, work: Work) => guard(name, extra, services, work);
  const saved = `Saves each clip as an mp4 with a jpg poster (srt and vtt in captions/) in a new folder under ${settings.outputDir}, best first, and returns their paths with title, score (0-100: 80+ post as is, under 50 weak), start/end in the source and a ready-to-post caption.`;
  const slow = `If it's still running after ${settings.waitSeconds} s you get a job_id: call get_job to keep waiting.`;
  const saveOption = z.boolean().optional().describe("Download the clips into the output folder (default true). false returns only their links, which work for 7 days without a key.");

  server.registerTool(
    "create_clips",
    {
      title: "Create clips",
      description: [
        "Cut a long talking video (podcast, interview, webinar, talk, stream VOD) into its best short clips, in the cloud: clipsdk transcribes it, picks the moments that stand on their own, reframes to the speaker, burns in captions and renders MP4s. Use it instead of cutting clips with local ffmpeg or whisper.",
        "The video is a local path (uploaded automatically, up to 5 GB) or a direct http(s) link to the file: MP4, MOV, WebM or MKV with speech, up to 3 h. YouTube, TikTok, Vimeo and other page links don't work.",
        "Costs $0.03 per source minute ($0.02 past 2,000 minutes in a month), or $0.03 per minute of delivered clips when that's more; sources above 1080p, above 60 fps or at a high bitrate cost at least $0.08 per clip minute. Billed per second; a failed job costs nothing.",
        `Takes minutes: rendering runs about 2x the clip length at 1080p30, four clips at a time, plus the analysis. ${saved} ${slow}`,
        "Per account: 3 jobs at once, 200 a day.",
      ].join(" "),
      inputSchema: {
        video: z.string().min(1).describe("The long video: a local file path, a direct http(s) link to the file, or a video_url from upload_file."),
        clips: z.number().int().min(1).max(20).optional().describe("How many clips, 1-20, default 5. Fewer come back when the video has fewer good moments."),
        min_seconds: z.number().int().min(10).max(MAX_CLIP_S).optional().describe(`Shortest clip in seconds, 10-90, default ${DEFAULT_MIN_S}.`),
        max_seconds: z.number().int().min(10).max(MAX_CLIP_S).optional().describe(`Longest clip in seconds, 10-90, default ${DEFAULT_MAX_S}; at least min_seconds + ${MIN_WINDOW_S}.`),
        aspect: z.enum(["9:16", "1:1", "4:5", "16:9"]).optional().describe("9:16 (default, 1080x1920 for TikTok, Reels and Shorts), 1:1 (1080x1080), 4:5 (1080x1350) or 16:9 (1920x1080)."),
        reframe: z.enum(["auto", "center", "none"]).optional().describe("auto (default) follows the speaker, center crops the middle, none shows the whole frame over a blurred copy."),
        captions: z
          .enum(["bold", "karaoke", "minimal", "none"])
          .optional()
          .describe("Burned-in caption style: bold (default), karaoke or minimal, or none. srt and vtt files come back either way."),
        language: z.string().regex(LANGUAGE, "use an ISO 639-1 code like en or es").optional().describe("Spoken language as an ISO 639-1 code like en; detected when left out."),
        prompt: z.string().min(1).max(500).optional().describe('What to look for, up to 500 characters, e.g. "moments about pricing".'),
        webhook_url: z.string().max(4096).optional().describe("https URL that gets a POST with the finished job, signed with the Clipsdk-Signature header."),
        save: saveOption,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) =>
      tool("create_clips", extra, async (ctx, { media, jobs }) => {
        const minS = args.min_seconds ?? DEFAULT_MIN_S;
        const maxS = args.max_seconds ?? DEFAULT_MAX_S;
        if (minS + MIN_WINDOW_S > MAX_CLIP_S) throw new ToolError(`min_seconds can be at most ${MAX_CLIP_S - MIN_WINDOW_S}, since max_seconds (up to ${MAX_CLIP_S}) must be at least min_seconds + ${MIN_WINDOW_S}.`);
        if (maxS < minS + MIN_WINDOW_S) {
          throw new ToolError(`max_seconds must be at least min_seconds + ${MIN_WINDOW_S}: pass max_seconds ${minS + MIN_WINDOW_S} or more${args.max_seconds === undefined ? ` (it defaults to ${DEFAULT_MAX_S})` : ""}.`);
        }
        if (args.webhook_url !== undefined) checkWebhook(args.webhook_url);

        // We check everything above first, so a request that can't work never uploads a big file
        const videoUrl = await media.toUrl(args.video, ctx);
        const request = compact({
          video_url: videoUrl,
          clips: args.clips,
          min_seconds: args.min_seconds,
          max_seconds: args.max_seconds,
          aspect: args.aspect,
          reframe: args.reframe,
          captions: args.captions === "none" ? (false as const) : args.captions,
          language: args.language,
          prompt: args.prompt,
          webhook_url: args.webhook_url,
        });
        return jobs.start({ ...request, video_url: videoUrl }, stemOf(args.video), args.save ?? true, ctx);
      }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: `Wait for a clips job that create_clips returned as still running, then save its clips just like create_clips would have. Waits up to ${settings.waitSeconds} s per call; if it's still running, call it again. Also works for a job created through the API with the same key, and explains why a job failed.`,
      inputSchema: {
        job_id: z.string().regex(JOB_ID, "job ids look like job_ followed by 20 lowercase letters and digits").describe("The job_id create_clips returned."),
        save: saveOption,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id, save }, extra) => tool("get_job", extra, (ctx, { jobs }) => jobs.resume(job_id, save ?? true, ctx)),
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload file",
      description:
        "Upload a local video (MP4, MOV, WebM or MKV, up to 5 GB) to clipsdk and get a video_url for create_clips that works for 7 days. create_clips uploads local paths itself, so only use this to reuse one big file across several calls or to hand the video_url to other code. Uploads count toward 20 GB per account per day.",
      inputSchema: {
        path: z.string().min(1).describe("Local video file path, absolute or relative to the project."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ path: input }, extra) =>
      tool("upload_file", extra, async (ctx, { media }) => {
        const file = await media.localFile(input);
        const ticket = await media.upload(file, ctx);
        return textResult(`Uploaded ${file.path}. Pass this video_url to create_clips; clipsdk keeps it 7 days: ${ticket.video_url}`, {
          path: file.path,
          bytes: file.size,
          video_url: ticket.video_url,
        });
      }),
  );
}

async function guard(name: string, extra: Extra, services: () => Services, work: Work): Promise<CallToolResult> {
  const ctx: ToolContext = { signal: extra.signal, startedAt: Date.now(), progress: progressReporter(extra) };
  try {
    return await work(ctx, services());
  } catch (error) {
    if (error instanceof StillUploading) return uploadingResult(error.file, error.sent, error.size, `call ${name} again with the same arguments`, ctx);
    return errorResult(error);
  }
}

function progressReporter(extra: Extra): (message: string) => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};

  let progress = 0;
  return (message) => {
    progress += 1;
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } })
      .catch((error: unknown) => log("progress notification failed", error));
  };
}

// clipsdk only calls an https URL on its default port, without a user name or password in it
function checkWebhook(value: string): void {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== "https:") throw new ToolError(`webhook_url must be an https URL, got "${value}".`);
  if (url.port || url.username || url.password) throw new ToolError("webhook_url must use https's default port and have no user:pass@ in it.");
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function stemOf(input: string): string {
  const value = input.trim();
  const raw = /^https?:\/\//i.test(value) && URL.canParse(value) ? safeDecode(new URL(value).pathname) : value;
  const base = path.basename(raw);
  return safeName(base.slice(0, base.length - path.extname(base).length) || "video");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
