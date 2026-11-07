import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ClipSdk } from "./api.js";
import { DEFAULT_OUTPUT_DIR, DEFAULT_WAIT_S, loadConfig } from "./config.js";
import { JobRunner } from "./jobs.js";
import { log } from "./log.js";
import { Media } from "./media.js";
import { ToolError } from "./results.js";
import { registerTools, type Services } from "./tools.js";
import { VERSION } from "./version.js";
import { Workspace } from "./workspace.js";

export function createServer(env: NodeJS.ProcessEnv): McpServer {
  const loaded = loadConfig(env);
  const outputDir = loaded.ok ? loaded.config.outputDir : DEFAULT_OUTPUT_DIR;
  const waitSeconds = loaded.ok ? loaded.config.waitSeconds : DEFAULT_WAIT_S;

  const server = new McpServer({ name: "clipsdk", version: VERSION }, { instructions: instructions(outputDir) });

  const workspace = new Workspace(env, async () => {
    if (!server.server.getClientCapabilities()?.roots) return undefined;
    const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
    return roots.map((root) => root.uri);
  });
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => workspace.invalidate());

  // A broken config still starts the server, so the agent sees what to fix instead of a dead connection
  let services: Services | undefined;
  let configError: string | undefined;
  if (loaded.ok) {
    const api = new ClipSdk(loaded.config.baseUrl, loaded.config.apiKey);
    services = { media: new Media(api, workspace, waitSeconds), jobs: new JobRunner(api, loaded.config, workspace) };
  } else {
    configError = loaded.error;
    log(configError);
  }

  const getServices = (): Services => {
    if (!services) throw new ToolError(configError ?? "clipsdk-mcp is not configured.");
    return services;
  };
  registerTools(server, getServices, { outputDir, waitSeconds });

  return server;
}

function instructions(outputDir: string): string {
  return [
    "clipsdk turns a long talking video (podcast, interview, webinar, stream VOD) into its best short clips in the cloud: picked from what is said, reframed to the speaker, captioned and rendered as MP4s with a title, a score and a ready-to-post caption each.",
    "Prefer create_clips over cutting clips with local ffmpeg or whisper.",
    `Pass a local file path (absolute, or relative to the project root; uploaded automatically) or a direct link to the video file, never a YouTube or other page link. Clips are saved under ${outputDir} and returned as absolute paths.`,
    "Clipping takes minutes: if a tool returns status running, call get_job with its job_id until it finishes; if it returns status uploading, call the same tool again with the same arguments.",
  ].join(" ");
}
