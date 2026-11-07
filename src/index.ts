import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "./log.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

// stdout is the protocol channel, so stray console output goes to stderr
console.log = console.info = console.debug = console.error;

if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

process.on("unhandledRejection", (error) => log("unhandled rejection", error));

const server = createServer(process.env);
await server.connect(new StdioServerTransport());
log(`v${VERSION} ready on stdio`);

if (process.stdin.isTTY) {
  log("this is an MCP server: add it to Claude Code, Cursor or another MCP client instead of running it by hand (see the README).");
}
