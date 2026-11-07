import { isNetworkPath } from "./paths.js";

export const DEFAULT_BASE_URL = "https://api.clipsdk.com";
export const DEFAULT_OUTPUT_DIR = "clipsdk-output";
export const DEFAULT_WAIT_S = 50;
export const MAX_WAIT_S = 300;

export interface Config {
  apiKey: string;
  baseUrl: string;
  outputDir: string;
  waitSeconds: number;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: string };

export function loadConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const problems: string[] = [];

  const apiKey = env.CLIPSDK_KEY?.trim() || "";
  if (!apiKey) {
    problems.push("CLIPSDK_KEY is not set. Add your clipsdk API key (csdk_live_..., from https://clipsdk.com/dashboard/keys) to the env of this MCP server in your client config, then restart the server.");
  }

  const rawBaseUrl = env.CLIPSDK_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const baseUrl = safeBaseUrl(rawBaseUrl);
  if (baseUrl === undefined) {
    problems.push(`CLIPSDK_BASE_URL must be an https URL (plain http only for localhost), got "${rawBaseUrl}".`);
  }

  const outputDir = env.CLIPSDK_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR;
  if (isNetworkPath(outputDir)) problems.push(`CLIPSDK_OUTPUT_DIR must be a folder on this computer, got "${outputDir}".`);

  const rawWait = env.CLIPSDK_WAIT_S?.trim();
  const waitSeconds = rawWait ? Number(rawWait) : DEFAULT_WAIT_S;
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    problems.push(`CLIPSDK_WAIT_S must be a number of seconds from 0 to ${MAX_WAIT_S}, got "${rawWait}".`);
  }

  if (problems.length > 0 || baseUrl === undefined) return { ok: false, error: problems.join(" ") };

  return {
    ok: true,
    config: {
      apiKey,
      baseUrl,
      outputDir,
      waitSeconds: Math.min(MAX_WAIT_S, Math.floor(waitSeconds)),
    },
  };
}

// The key goes along with every call, so only over https, or plain http to this machine. Paths are appended to
// the base, so it keeps only its origin and path: no credentials, query or fragment
function safeBaseUrl(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;

  const { protocol, hostname, origin, pathname } = new URL(value);
  const safe = protocol === "https:" || (protocol === "http:" && /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(hostname));
  return safe ? `${origin}${pathname.replace(/\/+$/, "")}` : undefined;
}
