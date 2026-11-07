export function log(message: string, error?: unknown): void {
  const detail = error === undefined ? "" : ` ${error instanceof Error ? (error.stack ?? errorMessage(error)) : String(error)}`;
  process.stderr.write(`[clipsdk-mcp] ${message}${detail}\n`);
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : "";
  return detail && detail !== error.message ? `${error.message}: ${detail}` : error.message;
}
