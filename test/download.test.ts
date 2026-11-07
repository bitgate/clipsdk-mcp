import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClipSdk } from "../src/api.js";
import { errorResult } from "../src/results.js";

interface Host {
  url: string;
  hits: { path: string; authorization?: string }[];
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  close(): Promise<void>;
}

async function startHost(): Promise<Host> {
  const server = createServer((req, res) => {
    host.hits.push({ path: req.url ?? "", authorization: req.headers.authorization });
    host.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const host: Host = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: [],
    handle: (_req, res) => res.end("file bytes"),
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return host;
}

let api: Host;
let other: Host;
let out: string;
let sdk: ClipSdk;

beforeEach(async () => {
  api = await startHost();
  other = await startHost();
  out = await realpath(await mkdtemp(path.join(os.tmpdir(), "clipsdk-download-")));
  sdk = new ClipSdk(api.url, "csdk_live_secret", { outputBytes: 1024, answerBytes: 512, idleMs: 300, bytesPerSecond: 256 });
});

afterEach(async () => {
  await Promise.all([api.close(), other.close()]);
  await rm(out, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;
const budget = () => sdk.outputBudget();
const file = (name = "video.mp4") => path.join(out, name);
const outputUrl = (name = "video.mp4") => `${api.url}/f/out/job_1/${name}`;

describe("downloads", () => {
  it("saves a file from the API's /f/ links without sending the key", async () => {
    expect(await sdk.download(outputUrl(), file(), signal(), budget())).toBe(10);

    expect(await readFile(file(), "utf8")).toBe("file bytes");
    expect(api.hits).toEqual([{ path: "/f/out/job_1/video.mp4", authorization: undefined }]);
  });

  it("keeps the link's signature", async () => {
    expect(await sdk.download(`${outputUrl()}?s=c2lnbmF0dXJl`, file(), signal(), budget())).toBe(10);

    expect(api.hits).toEqual([{ path: "/f/out/job_1/video.mp4?s=c2lnbmF0dXJl", authorization: undefined }]);
  });

  it("refuses files from any other origin or path", async () => {
    const urls = [
      `${other.url}/f/out/job_1/video.mp4`,
      api.url.replace("http:", "https:") + "/f/out/job_1/video.mp4",
      `${api.url}/v1/jobs/job_1`,
      `${api.url}/fx/video.mp4`,
      `${api.url}/f/../v1/jobs/job_1`,
      `${api.url}/f/%2e%2e/v1/jobs/job_1`,
      "file:///etc/passwd",
    ];
    for (const url of urls) {
      await expect(sdk.download(url, file(), signal(), budget()), url).rejects.toThrow(/refused/);
    }

    expect(api.hits).toEqual([]);
    expect(other.hits).toEqual([]);
    expect(await readdir(out)).toEqual([]);
  });

  it("never follows a redirect off the API's /f/ links", async () => {
    other.handle = (_req, res) => res.end("internal secrets");
    for (const location of [`${other.url}/f/out/job_1/video.mp4`, "/v1/jobs/job_1"]) {
      api.handle = (_req, res) => res.writeHead(302, { location }).end();
      await expect(sdk.download(outputUrl(), file(), signal(), budget()), location).rejects.toThrow(/refused/);
    }

    expect(other.hits).toEqual([]);
    expect(api.hits.map((hit) => hit.path)).toEqual(["/f/out/job_1/video.mp4", "/f/out/job_1/video.mp4"]);
    expect(await readdir(out)).toEqual([]);
  });

  it("follows a redirect that stays on the API's /f/ links", async () => {
    api.handle = (req, res) => (req.url === "/f/out/job_1/video.mp4" ? res.writeHead(307, { location: "/f/out/job_1/moved.mp4" }).end() : res.end("moved"));

    expect(await sdk.download(outputUrl(), file(), signal(), budget())).toBe(5);
    expect(await readFile(file(), "utf8")).toBe("moved");
  });

  it("gives up after a few redirects", async () => {
    api.handle = (req, res) => res.writeHead(302, { location: `${req.url}x` }).end();

    await expect(sdk.download(outputUrl(), file(), signal(), budget())).rejects.toThrow(/more than 3 redirects/);
    expect(api.hits).toHaveLength(4);
  });

  it("refuses a file that says it's over the cap before reading it", async () => {
    api.handle = (_req, res) => res.writeHead(200, { "content-length": String(2 ** 30) }).write("x");
    const started = Date.now();

    await expect(sdk.download(outputUrl(), file(), signal(), budget())).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await readdir(out)).toEqual([]);
  });

  it("stops at the cap while streaming a file of unknown size", async () => {
    api.handle = (_req, res) => {
      res.write("x".repeat(800));
      res.end("y".repeat(800));
    };

    await expect(sdk.download(outputUrl(), file(), signal(), budget())).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    expect(await readdir(out)).toEqual([]);
  });

  it("counts every file of a job against one budget", async () => {
    api.handle = (_req, res) => res.end("x".repeat(600));
    const budget = sdk.outputBudget();

    expect(await sdk.download(outputUrl("a.mp4"), file("a.mp4"), signal(), budget)).toBe(600);
    await expect(sdk.download(outputUrl("b.mp4"), file("b.mp4"), signal(), budget)).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    expect(await readdir(out)).toEqual(["a.mp4"]);
  });

  it("hands back what a failed attempt counted, so the retry fits", async () => {
    api.handle = (_req, res) => {
      if (api.hits.length > 1) return res.end("x".repeat(700));
      res.writeHead(200, { "content-length": "700" }).write("x".repeat(600));
      setTimeout(() => res.destroy(), 50);
    };

    expect(await sdk.download(outputUrl(), file(), signal(), budget())).toBe(700);
    expect(api.hits).toHaveLength(2);
  });

  it("stops a download that goes quiet, without retrying it", async () => {
    api.handle = (_req, res) => res.writeHead(200, { "content-length": "100" }).write("x");
    const started = Date.now();

    await expect(sdk.download(outputUrl(), file(), signal(), budget())).rejects.toMatchObject({ code: "DOWNLOAD_TIMEOUT", message: "no data for 0.3 s" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(api.hits).toHaveLength(1);
    expect(await readdir(out)).toEqual([]);
  });

  it("stops a download that trickles past the time its size allows", { timeout: 4000 }, async () => {
    sdk = new ClipSdk(api.url, "csdk_live_secret", { outputBytes: 1024, idleMs: 1000, bytesPerSecond: 2000 });
    api.handle = (_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      const timer = setInterval(() => res.write("x".repeat(20)), 100);
      res.on("close", () => clearInterval(timer));
    };
    const started = Date.now();

    await expect(sdk.download(outputUrl(), file(), signal(), budget())).rejects.toMatchObject({ code: "DOWNLOAD_TIMEOUT", message: "not done after 2 s" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await readdir(out)).toEqual([]);
  });

  it("gives a slow but steady download the time its size needs", async () => {
    sdk = new ClipSdk(api.url, "csdk_live_secret", { outputBytes: 1024, idleMs: 1000, bytesPerSecond: 500 });
    api.handle = (_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      let chunks = 0;
      const timer = setInterval(() => {
        chunks += 1;
        if (chunks < 20) return void res.write("x".repeat(50));
        clearInterval(timer);
        res.end("x".repeat(50));
      }, 100);
      res.on("close", () => clearInterval(timer));
    };

    expect(await sdk.download(outputUrl(), file(), signal(), budget())).toBe(1000);
  });

  it("waits as long as a download without a size may take", async () => {
    sdk = new ClipSdk(api.url, "csdk_live_secret", { idleMs: 1000, bytesPerSecond: 1 });
    api.handle = (_req, res) => {
      res.writeHead(200);
      setTimeout(() => res.end("file bytes"), 50);
    };

    expect(await sdk.download(outputUrl(), file(), signal(), budget())).toBe(10);
  });

  it("takes the job's budget from its caller", () => {
    // @ts-expect-error every file of a job counts against the same budget
    const unbudgeted = () => sdk.download(outputUrl(), file(), signal());
    expect(unbudgeted).toBeTypeOf("function");
  });
});

describe("answers", () => {
  it("refuses an answer over the cap", async () => {
    api.handle = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).write('{"job": {"id": "job_1", "status": "running", "pad": "');
      res.end(`${"x".repeat(1000)}"}}`);
    };

    const error = await sdk.getJob("job_1", 0, signal()).catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(errorResult(error).content).toEqual([{ type: "text", text: "clipsdk-mcp refused clipsdk's answer (RESPONSE_TOO_LARGE): the answer is over 1 MiB" }]);
  });

  it("refuses an answer that says it's over the cap before reading it", { timeout: 3000 }, async () => {
    api.handle = (_req, res) => res.writeHead(200, { "content-length": String(2 ** 30) }).write("{");

    await expect(sdk.getJob("job_1", 0, signal())).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("reads a normal answer", async () => {
    api.handle = (_req, res) => res.end(JSON.stringify({ job: { id: "job_1", status: "running" } }));

    expect(await sdk.getJob("job_1", 0, signal())).toMatchObject({ id: "job_1", status: "running" });
  });
});
