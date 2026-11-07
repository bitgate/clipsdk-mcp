export interface ToolContext {
  signal: AbortSignal;
  startedAt: number;
  progress(message: string): void;
}

export type FileKind = "video" | "poster" | "srt" | "vtt";

export interface SavedFile {
  clip: number;
  kind: FileKind;
  url: string;
  path?: string;
  bytes?: number;
  error?: string;
}

export interface SavedJob {
  folder?: string;
  files: SavedFile[];
  error?: string;
}

export function elapsedSeconds(ctx: ToolContext): number {
  return Math.round((Date.now() - ctx.startedAt) / 100) / 10;
}
