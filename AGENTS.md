# AGENTS.md

Local stdio MCP server that wraps the clipsdk clipping API. The API contract lives in the `bitgate/clipsdk` repo (`docs/CLIPS.md`, `worker/clips/clipsdk.ts`) and at https://api.clipsdk.com/openapi.json and https://api.clipsdk.com/llms.txt.

## Layout

- `src/index.ts`: entry point, stdio transport
- `src/server.ts`: builds the `McpServer`, its instructions, project root detection, config errors
- `src/tools.ts`: the three tools; names, descriptions and parameter docs are what agents read to pick a tool
- `src/api.ts`: HTTP client: `POST /v1/clips` with one Idempotency-Key per call (so repeats are safe), `GET /v1/jobs/{id}`, upload tickets and the presigned PUT, capped answers, and downloads from the API's own `/f/` links only
- `src/jobs.ts`: create job, long-poll, save each job's clips into a folder of its own without overwriting
- `src/media.ts`: local path or link to a `video_url`, link checks (page links, private hosts), upload checks (network paths, hidden files, 5 GB, container), background uploads shared between calls, the upload cache
- `src/paths.ts`: network and device names, link walks, exclusive saves that stay inside a folder
- `src/sniff.ts`: tells MP4, MOV, WebM and MKV apart from everything else by their first bytes
- `src/results.ts`: tool results and a hint for every API and job error code
- `test/`: vitest against `test/fake-api.ts`, through a real MCP client over an in-memory transport

## Rules

- Never write to stdout: it's the protocol channel. Log with `log()` from `src/log.ts` (stderr).
- `dist/index.js` is committed and must match the source: run `npm run bundle` and commit it. CI fails on drift (`npm run bundle:check`).
- No `build`, `prepare`, `prepack`, `install`, `preinstall` or `postinstall` scripts: npm would then run a full dev install whenever someone starts the server with `npx github:bitgate/clipsdk-mcp`.
- No runtime dependencies. Everything is bundled into `dist/index.js`.
- Import zod as `import * as z from "zod"`; `import { z }` pulls every zod locale into the bundle.
- `vite` is pinned to 7 in `overrides`: vite 8 crashes npm 10's installer (`Cannot read properties of null (reading 'edgesOut')`).
- Prices, limits and error codes in tool descriptions and hints follow https://api.clipsdk.com/llms.txt; change them together when the API changes.
- Keep tool descriptions short and concrete: what it does, what it costs, what comes back, how long it takes.
- Bump `version` in `package.json` and `src/version.ts` together (a test checks they match).
- Names from the API go through `safeName`; files are written only with `placeIn` and `saveExclusive`.

## Checks

```bash
npm run typecheck && npm test && npm run bundle:check
```

Live smoke test: `npx @modelcontextprotocol/inspector -e CLIPSDK_KEY=csdk_live_... node dist/index.js`.
