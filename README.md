# clipsdk-mcp

Let your coding agent cut a long video into its best short clips. A podcast, interview, webinar or stream goes in; vertical MP4s with burned-in captions come out, each with a title, a score and a ready-to-post caption. The clipping runs on [clipsdk](https://clipsdk.com) and the clips land in your project. No ffmpeg, whisper or GPU on your machine.

```text
> cut ./episode-42.mp4 into 5 clips for TikTok
> find the 3 best moments about pricing in https://cdn.example.com/webinar.mp4, 30-45 s each
> make square clips with karaoke captions from ~/Movies/keynote.mov
```

The agent calls `create_clips`, clipsdk transcribes the video, picks the moments that stand on their own, follows the speaker and renders each clip, and the agent gets the clips back.

Connect it two ways, both with a clipsdk API key (`csdk_live_...`) from [clipsdk.com/dashboard/keys](https://clipsdk.com/dashboard/keys):

- **Hosted**: `https://mcp.clipsdk.com/mcp`. Nothing to install. The clips come back as links.
- **Local**: this package over stdio, with Node 20+. It uploads local files itself and saves the clips in `./clipsdk-output/<video>/`.

## Hosted server

`https://mcp.clipsdk.com/mcp` speaks Streamable HTTP and takes your key as a Bearer header. It has no OAuth sign-in, so it works in clients where you can set a header, not as a claude.ai or ChatGPT connector.

### Claude Code

```bash
claude mcp add --transport http clipsdk https://mcp.clipsdk.com/mcp --header "Authorization: Bearer csdk_live_xxx"
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in your project):

```json
{
  "mcpServers": {
    "clipsdk": {
      "url": "https://mcp.clipsdk.com/mcp",
      "headers": { "Authorization": "Bearer csdk_live_xxx" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` (asks for the key once and stores it encrypted):

```json
{
  "inputs": [{ "type": "promptString", "id": "clipsdk-key", "description": "clipsdk API key", "password": true }],
  "servers": {
    "clipsdk": {
      "type": "http",
      "url": "https://mcp.clipsdk.com/mcp",
      "headers": { "Authorization": "Bearer ${input:clipsdk-key}" }
    }
  }
}
```

### Windsurf

Open MCP config file in Cascade's MCP menu and add:

```json
{
  "mcpServers": {
    "clipsdk": {
      "serverUrl": "https://mcp.clipsdk.com/mcp",
      "headers": { "Authorization": "Bearer csdk_live_xxx" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`, with `CLIPSDK_KEY` set in your environment:

```toml
[mcp_servers.clipsdk]
url = "https://mcp.clipsdk.com/mcp"
bearer_token_env_var = "CLIPSDK_KEY"
```

### Gemini CLI

```bash
gemini mcp add --transport http --header "Authorization: Bearer csdk_live_xxx" clipsdk https://mcp.clipsdk.com/mcp
```

### Hosted tools

| Tool | What it does |
| --- | --- |
| `create_clips` | Turns a long video into 1-20 short clips and returns their links. Takes `video_url`, a direct link to the file or the `video_url` from `create_upload`, the same `clips`, `min_seconds`, `max_seconds`, `aspect`, `reframe`, `captions`, `language`, `prompt` and `webhook_url` as the local tool, plus `wait_s` (0-60 s, default 50) and `idempotency_key`. |
| `get_job` | Waits on a job by `job_id` (and `wait_s`) and returns its clips, or why it failed. |
| `create_upload` | Takes the file's name or local path as `filename` and its exact `size` in bytes, and returns a `video_url` plus the `curl` command that uploads the file straight to storage. A path with characters a shell could misread comes back as `YOUR_FILE` in that command, for the agent to fill in. |

Clip links work for 7 days and need no key. Same pricing and limits as the local server.

## Local server

### Claude Code

```bash
claude mcp add clipsdk --env CLIPSDK_KEY=csdk_live_xxx -- npx -y github:bitgate/clipsdk-mcp
```

Add `--scope project` to share it with your team through `.mcp.json`.

### Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "clipsdk": {
      "command": "npx",
      "args": ["-y", "github:bitgate/clipsdk-mcp"],
      "env": { "CLIPSDK_KEY": "csdk_live_xxx" }
    }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`). Desktop has no project folder, so pass absolute paths and pick where clips go:

```json
{
  "mcpServers": {
    "clipsdk": {
      "command": "npx",
      "args": ["-y", "github:bitgate/clipsdk-mcp"],
      "env": { "CLIPSDK_KEY": "csdk_live_xxx", "CLIPSDK_OUTPUT_DIR": "~/Movies/clipsdk" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` (asks for the key once and stores it encrypted):

```json
{
  "inputs": [{ "type": "promptString", "id": "clipsdk-key", "description": "clipsdk API key", "password": true }],
  "servers": {
    "clipsdk": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:bitgate/clipsdk-mcp"],
      "env": { "CLIPSDK_KEY": "${input:clipsdk-key}" }
    }
  }
}
```

### Windsurf

Settings → Cascade → MCP Servers → View raw config, then add the same `mcpServers` entry as Cursor.

### Claude Code skill

The skill in [`skills/clipsdk/SKILL.md`](skills/clipsdk/SKILL.md) tells Claude when to reach for clipsdk and how to turn "3 square clips about pricing" into tool arguments:

```bash
mkdir -p ~/.claude/skills/clipsdk
curl -fsSL https://raw.githubusercontent.com/bitgate/clipsdk-mcp/master/skills/clipsdk/SKILL.md -o ~/.claude/skills/clipsdk/SKILL.md
```

Then ask for clips, or type `/clipsdk ./episode-42.mp4`. Put it in `.claude/skills/clipsdk/` in a repo to share it with your team.

## Local tools

| Tool | What it does |
| --- | --- |
| `create_clips` | Turns a long video into 1-20 short clips and saves them. Waits up to `CLIPSDK_WAIT_S` seconds, then hands back a `job_id`. |
| `get_job` | Keeps waiting on a job that outlived the tool call and saves its clips when it's done. Also explains why a job failed. |
| `upload_file` | Uploads a local video and returns a `video_url` valid for 7 days. Rarely needed: `create_clips` uploads local paths itself. |

`create_clips` takes:

| Parameter | Values | Default |
| --- | --- | --- |
| `video` | Required. A local file path, a direct http(s) link to the file, or a `video_url` from `upload_file`. | |
| `clips` | 1-20. Fewer come back when the video has fewer good moments. | `5` |
| `min_seconds` | Shortest clip, 10-85 s. | `20` |
| `max_seconds` | Longest clip, 15-90 s, at least `min_seconds` + 5. | `60` |
| `aspect` | `9:16` (1080x1920), `1:1` (1080x1080), `4:5` (1080x1350) or `16:9` (1920x1080). | `9:16` |
| `reframe` | `auto` follows the speaker, `center` crops the middle, `none` shows the whole frame over a blurred copy. | `auto` |
| `captions` | Burned-in style: `bold`, `karaoke`, `minimal` or `none`. srt and vtt come back either way. | `bold` |
| `language` | Spoken language as an ISO 639-1 code like `en`. | detected |
| `prompt` | What to look for, up to 500 characters, like `moments about pricing`. | |
| `webhook_url` | https URL that gets a POST with the finished job, signed with the `Clipsdk-Signature` header. | |
| `save` | `false` returns the clip links (valid 7 days, no key needed) instead of downloading them. | `true` |

`get_job` takes `job_id` and `save`. `upload_file` takes `path`.

Each job gets a folder of its own, with the clips numbered best first:

```text
clipsdk-output/episode-42/
  01-why-pricing-pages-fail.mp4
  01-why-pricing-pages-fail.jpg
  02-the-metric-nobody-tracks.mp4
  02-the-metric-nobody-tracks.jpg
  captions/01-why-pricing-pages-fail.srt
  captions/01-why-pricing-pages-fail.vtt
  ...
```

The tool result lists each clip's title, score (0-100: 80 and up post as is, under 50 is weak), start and end in the source, post caption, why it was picked, and its files. A second run on the same video goes into `episode-42-2/`, so nothing is overwritten. Subtitle files sit in `captions/` so players don't stack them on top of the burned-in captions.

Clipping takes minutes: rendering runs about 2x the clip length at 1080p30, four clips at a time, plus the analysis. Tools send progress updates if your client shows them, and a job that outlasts `CLIPSDK_WAIT_S` comes back as a `job_id` for `get_job`. A big upload that outlasts it keeps going in the background, and calling the same tool again picks it up.

## Pricing

$0.03 per minute of source video ($0.02 past 2,000 minutes in a UTC month), or $0.03 per minute of delivered clips when that's more. Sources above 1080p, above 60 fps or at a high bitrate (over 55 Mb/s for H.264, 20 Mb/s for other codecs) cost at least $0.08 per clip minute; HDR alone doesn't change the price. Billed per second. Failed jobs and failed renders cost nothing.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `CLIPSDK_KEY` | | Required. Your `csdk_live_...` key. |
| `CLIPSDK_OUTPUT_DIR` | `clipsdk-output` | Where clips are saved, on this computer (not a network share). Relative paths resolve against the project root and may not pass through a link; use an absolute path to save elsewhere. |
| `CLIPSDK_WAIT_S` | `50` | Seconds a tool waits before handing back a `job_id` (0-300). Keep it under your client's tool timeout. |
| `CLIPSDK_BASE_URL` | `https://api.clipsdk.com` | API endpoint. https only; plain http only for localhost. |

The project root is `CLAUDE_PROJECT_DIR` when Claude Code sets it, else the client's first workspace root, else the directory the server was started in. Roots on another machine are skipped.

## Limits

Sources up to 3 hours and 5 GB, as MP4, MOV, WebM or MKV with speech. Per account, shared by its keys: 3 jobs running at once, 200 jobs and 20 GB of uploads per UTC day; past a limit the tool says when to try again. Clips and uploads are kept 7 days.

Links must point at the video file itself. YouTube, TikTok, Instagram, Vimeo, X, Facebook, Twitch, Rumble, Dailymotion and Loom page links are refused, and so are localhost and private addresses, non-default ports and links with a user name or password.

A local file is only uploaded when it starts like an MP4, MOV, WebM or MKV video. Hidden files and folders, meaning names that start with a dot (`.env`, `~/.ssh`), and paths on another machine (`\\server\share`) are refused.

Up to 8 GiB of clips are saved per job. A download that sends nothing for 60 s, or runs slower than about 64 KiB/s, stops; the clip stays on clipsdk and its link is in the result. Clips are only downloaded from the API's own `/f/` links, and never saved through a link inside the project or the output folder. Node can't open or rename relative to a folder handle, so another program running as you could still swap a folder for a link between the last check and the final rename.

## Development

```bash
npm ci
npm test            # unit + tool tests against a fake API
npm run typecheck
npm run bundle      # rebuilds dist/index.js, which is committed
```

`dist/` is committed so `npx github:bitgate/clipsdk-mcp` starts without a build step. See [AGENTS.md](AGENTS.md).

## License

MIT
