---
name: clipsdk
description: Cut a long talking video (podcast, interview, webinar, talk, stream VOD) into its best short clips with burned-in captions, using the clipsdk MCP tools. Use when the user asks for clips, shorts, reels, TikToks or highlights from a video file or a direct link to one.
license: MIT
compatibility: Needs the clipsdk MCP server (npx -y github:bitgate/clipsdk-mcp, Node 20+) with CLIPSDK_KEY set. Without it, falls back to the clipsdk HTTP API.
allowed-tools: mcp__clipsdk__create_clips mcp__clipsdk__get_job mcp__clipsdk__upload_file
---

# clipsdk

Turn one long video into ranked short clips with the `clipsdk` MCP tools: `create_clips`, `get_job` and `upload_file`. Use them instead of cutting clips with local ffmpeg or whisper.

## Steps

1. Get the video: a local file path or a direct https link to the file (MP4, MOV, WebM or MKV, up to 3 hours and 5 GB). YouTube, Twitch, TikTok, Vimeo and other page links fail. If the user gives one, ask for the file or a direct file link instead.
2. Turn the request into `create_clips` arguments. Set only what the user asked for; the defaults are good.

   | The user says | Argument |
   | --- | --- |
   | "3 clips" | `clips: 3` (1 to 20, default 5) |
   | "between 20 and 45 seconds" | `min_seconds: 20, max_seconds: 45` (10 to 90, max at least min + 5) |
   | "square" | `aspect: "1:1"`; "4:5" for feed posts, "16:9" for landscape, default "9:16" |
   | "karaoke captions", "no captions" | `captions: "karaoke"` or `"none"`; bold (default), karaoke, minimal |
   | "keep the whole frame" | `reframe: "none"`; `"center"` for a center crop, default follows the speaker |
   | "about pricing", "the funny bits" | `prompt: "moments about pricing"` (up to 500 characters) |
   | the spoken language | `language: "es"` (detected when left out) |

3. Call `create_clips`. If it returns status `running`, call `get_job` with its `job_id` until it finishes. If it returns status `uploading`, call `create_clips` again with the same arguments.
4. Report each clip best first: title, score, length, the saved file path and its post caption. A score of 80 or more can be posted as is; under 50 is weak.

## Rules

- Each run is billed: $0.03 per source minute. Don't run the same video again to retry one weak clip unless the user asks.
- Clip links expire after 7 days. Files saved in the output folder stay.
- When a tool returns an error, pass on its hint (bad key, no credit, page link, file too long) and tell the user what to change.

## Without the MCP server

If the `clipsdk` tools are missing, use the HTTP API with the key in `CLIPSDK_KEY`:

```bash
curl -sS https://api.clipsdk.com/v1/clips \
  -H "Authorization: Bearer $CLIPSDK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"video_url": "https://cdn.example.com/episode.mp4", "clips": 3}'
```

The reply is the job. Until its `status` is `succeeded` or `failed`, call `GET https://api.clipsdk.com/v1/jobs/<id>?wait=60` with the same header. For a local file, `POST /v1/uploads` with its `filename` and `size` first, PUT the bytes to the `upload_url` it returns and send its `video_url`. Full reference: https://api.clipsdk.com/llms.txt
