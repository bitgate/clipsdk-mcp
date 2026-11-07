import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Clip } from "../src/api.js";
import { plannedFiles, safeName, slugify } from "../src/jobs.js";
import { hasHiddenSegment, isDeviceName, isNetworkPath } from "../src/paths.js";
import { videoContainer } from "../src/sniff.js";
import { VERSION } from "../src/version.js";
import { resolvePath, Workspace } from "../src/workspace.js";

describe("loadConfig", () => {
  it("requires a key", () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("CLIPSDK_KEY");
  });

  it("applies defaults", () => {
    expect(loadConfig({ CLIPSDK_KEY: "csdk_live_x" })).toEqual({
      ok: true,
      config: { apiKey: "csdk_live_x", baseUrl: "https://api.clipsdk.com", outputDir: "clipsdk-output", waitSeconds: 50 },
    });
  });

  it("clamps the wait and rejects nonsense", () => {
    expect(loadConfig({ CLIPSDK_KEY: "k", CLIPSDK_WAIT_S: "900" })).toMatchObject({ ok: true, config: { waitSeconds: 300 } });
    expect(loadConfig({ CLIPSDK_KEY: "k", CLIPSDK_WAIT_S: "soon" }).ok).toBe(false);
    expect(loadConfig({ CLIPSDK_KEY: "k", CLIPSDK_BASE_URL: "ftp://example.com" }).ok).toBe(false);
  });

  it("sends the key over https, or plain http only to this machine", () => {
    for (const url of ["https://api.clipsdk.com", "http://localhost:8787", "http://127.0.0.1:9000", "http://[::1]:3000"]) {
      expect(loadConfig({ CLIPSDK_KEY: "k", CLIPSDK_BASE_URL: url }).ok, url).toBe(true);
    }
    for (const url of ["http://api.clipsdk.com", "http://localhost.attacker.com", "http://127.0.0.1.nip.io", "http://10.0.0.5"]) {
      expect(loadConfig({ CLIPSDK_KEY: "k", CLIPSDK_BASE_URL: url }).ok, url).toBe(false);
    }
  });

  it("keeps only the base URL's origin and path", () => {
    for (const [url, base] of [
      ["https://user:secret@api.example.com/v2/?debug=1#top", "https://api.example.com/v2"],
      ["https://api.example.com/", "https://api.example.com"],
      ["http://localhost:8787?x=1", "http://localhost:8787"],
    ]) {
      expect(loadConfig({ CLIPSDK_KEY: "k", CLIPSDK_BASE_URL: url }), url).toMatchObject({ ok: true, config: { baseUrl: base } });
    }
  });

  it("refuses an output folder on another machine", () => {
    for (const dir of ["\\\\server\\share\\out", "//server/share/out", "file://server/share/out"]) {
      const result = loadConfig({ CLIPSDK_KEY: "k", CLIPSDK_OUTPUT_DIR: dir });
      expect(result.ok ? "" : result.error, dir).toContain("CLIPSDK_OUTPUT_DIR must be a folder on this computer");
    }
  });
});

describe("output names", () => {
  const url = (clip: number, name: string) => `https://api.clipsdk.com/f/out/job_x/${clip}/${name}?s=sig`;
  const clip = (number: number, title: string, links: Partial<Clip> = {}): Clip => ({
    rank: number,
    score: 80,
    title,
    reason: "",
    start_s: 0,
    end_s: 30,
    duration_s: 30,
    transcript: "",
    post_caption: "",
    video: url(number, "video.mp4"),
    poster: url(number, "poster.jpg"),
    srt: url(number, "captions.srt"),
    vtt: url(number, "captions.vtt"),
    ...links,
  });

  it("puts each clip's video and poster side by side, best first, and its subtitles in captions/", () => {
    const planned = plannedFiles([clip(1, "Why Pricing Pages Fail!"), clip(2, "", { poster: null, srt: null, vtt: null }), clip(3, "../../etc/passwd")]);

    expect(planned.map(({ clip, kind, name }) => [clip, kind, name])).toEqual([
      [1, "video", "01-why-pricing-pages-fail.mp4"],
      [1, "poster", "01-why-pricing-pages-fail.jpg"],
      [1, "srt", path.join("captions", "01-why-pricing-pages-fail.srt")],
      [1, "vtt", path.join("captions", "01-why-pricing-pages-fail.vtt")],
      [2, "video", "02-clip.mp4"],
      [3, "video", "03-etc-passwd.mp4"],
      [3, "poster", "03-etc-passwd.jpg"],
      [3, "srt", path.join("captions", "03-etc-passwd.srt")],
      [3, "vtt", path.join("captions", "03-etc-passwd.vtt")],
    ]);
    expect(planned[0]!.url).toBe(url(1, "video.mp4"));
  });

  it("numbers clips by their place in the list, whatever rank the API gave them", () => {
    expect(plannedFiles([clip(7, "a", { poster: null, srt: null, vtt: null }), clip(7, "a", { poster: null, srt: null, vtt: null })]).map((file) => file.name)).toEqual(["01-a.mp4", "02-a.mp4"]);
  });

  it("turns a name from the API into one plain file name Windows can open", () => {
    const cases: [string, string][] = [
      ["out.mp4", "out.mp4"],
      ["../../../evil", "evil"],
      ["..", "output"],
      ["C:\\Windows\\win.ini", "C_Windows_win.ini"],
      ["CON", "CON_"],
      ["nul.mp4", "nul_.mp4"],
      ["COM1.tar.gz", "COM1_.tar.gz"],
      ["lpt9", "lpt9_"],
      ["clip.mp4.", "clip.mp4"],
      ["clip.mp4 . .", "clip.mp4_._"],
      [`${"a".repeat(250)}.mp4`, `${"a".repeat(60)}.mp4`],
      ["b".repeat(300), "b".repeat(64)],
      [`${"c".repeat(63)}.${"d".repeat(10)}`, "c".repeat(63)],
    ];
    for (const [name, safe] of cases) expect(safeName(name), name).toBe(safe);
  });

  it("slugifies titles", () => {
    expect(slugify("Café Noir: The Ghost Ship!")).toBe("cafe-noir-the-ghost-ship");
  });
});

describe("resolvePath", () => {
  it("handles relative, home and file URL paths", () => {
    expect(resolvePath("clip.mp4", "/project")).toBe(path.resolve("/project", "clip.mp4"));
    expect(resolvePath("~/clip.mp4", "/project")).toBe(path.join(os.homedir(), "clip.mp4"));
    expect(resolvePath("file:///tmp/clip.mp4", "/project")).toBe(path.resolve("/tmp/clip.mp4"));
  });

  it("never takes a project folder on another machine", async () => {
    const workspace = new Workspace({ CLAUDE_PROJECT_DIR: "\\\\server\\share\\project" }, async () => ["file://server/share/project", "file:///home/me/project"]);

    expect(await workspace.baseDir()).toBe("/home/me/project");
  });
});

describe("Windows path rules", () => {
  it("treats UNC, device and NT paths as another machine", () => {
    const remote = [
      "\\\\server\\share\\clip.mp4",
      "//server/share/clip.mp4",
      "\\/server/share/clip.mp4",
      "\\\\?\\UNC\\server\\share\\clip.mp4",
      "\\\\?\\C:\\clip.mp4",
      "\\\\.\\pipe\\clip",
      "\\??\\C:\\clip.mp4",
      "file://server/share/clip.mp4",
      "file:////server/share/clip.mp4",
      "FILE://server/clip.mp4",
    ];
    for (const input of remote) expect(isNetworkPath(input), input).toBe(true);

    for (const input of ["C:\\Users\\me\\clip.mp4", "\\clip.mp4", "/home/me/clip.mp4", "clip.mp4", "file:///home/me/clip.mp4", "file:///C:/clip.mp4"]) {
      expect(isNetworkPath(input), input).toBe(false);
    }
  });

  it("knows the device names, whatever the extension", () => {
    for (const name of ["CON", "con", "PRN.mp4", "AUX", "NUL.txt", "nul.tar.gz", "COM0", "COM1", "com9.log", "LPT1", "lpt9.mp4"]) {
      expect(isDeviceName(name), name).toBe(true);
    }
    for (const name of ["CONSOLE", "con_.txt", "nul-1.mp4", "COM10", "LPT", "clip.mp4"]) {
      expect(isDeviceName(name), name).toBe(false);
    }
  });

  it("finds hidden folders below the project, and anywhere outside it", () => {
    expect(hasHiddenSegment("/home/me/.config/project/clip.mp4", "/home/me/.config/project")).toBe(false);
    expect(hasHiddenSegment("/home/me/project/.env", "/home/me/project")).toBe(true);
    expect(hasHiddenSegment("/home/me/.ssh/id_rsa", "/home/me/project")).toBe(true);
    expect(hasHiddenSegment("/home/me/Downloads/clip.mp4", "/home/me/project")).toBe(false);
  });
});

describe("videoContainer", () => {
  const ebml = (docType: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | docType.length]), Buffer.from(docType)]);
  const ftyp = (brand: string) => Buffer.from(`\0\0\0\x18ftyp${brand}\0\0\x02\0isomiso2`, "latin1");

  it("recognises MP4, MOV, WebM and MKV by their first bytes", () => {
    const heads: [string, Buffer][] = [
      ["mp4", ftyp("isom")],
      ["mp4", ftyp("mp42")],
      ["mp4", ftyp("M4V ")],
      ["mov", ftyp("qt  ")],
      ["mov", Buffer.from("\0\0\0\x08wide\0\0\0\x10mdat", "latin1")],
      ["webm", ebml("webm")],
      ["mkv", ebml("matroska")],
    ];
    for (const [container, head] of heads) expect(videoContainer(head, 1000), `${container} ${head.toString("latin1", 4, 12)}`).toBe(container);
  });

  it("refuses anything else, whatever its name", () => {
    const transportStream = Buffer.alloc(400);
    for (const offset of [0, 188, 376]) transportStream[offset] = 0x47;

    const heads: Record<string, Buffer> = {
      m4a: ftyp("M4A "),
      heic: ftyp("heic"),
      avif: ftyp("avif"),
      ts: transportStream,
      avi: Buffer.from("RIFF\x24\0\0\0AVI LIST", "latin1"),
      png: Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1"),
      mp3: Buffer.from([0xff, 0xfb, 0x90, 0x64]),
      srt: Buffer.from("1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n"),
      sshKey: Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\n"),
      env: Buffer.from("OPENAI_API_KEY=sk-123\n"),
      zip: Buffer.from("PK\x03\x04", "latin1"),
      oversizedBox: Buffer.from("\x7f\0\0\0ftypisom", "latin1"),
      empty: Buffer.alloc(0),
    };
    for (const [kind, head] of Object.entries(heads)) expect(videoContainer(head, 1000), kind).toBeUndefined();
  });
});

it("VERSION matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
