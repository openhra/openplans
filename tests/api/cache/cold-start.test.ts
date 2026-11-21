import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvedTestEnvironment } from "../../plugins/approval-helpers.js";
import { plantMutantFile } from "../../mutant-file.js";

// The first web-stream reader release in a process costs about a millisecond (Node builds its
// released-reader error in a fresh internal context). The cache's miss path releases a reader on
// every cacheable response, so without a start-up warm-up the first cacheable request pays it:
// cold /v1/zip-counties p50 rose 2.4 ms in the v0.4.18 startup A/B. The built server is started
// as production starts it, with a synthetic, unreachable database address.
const server = new URL("../../../dist/api/server.js", import.meta.url).pathname;
const WARM_UP = "await warmResponseBodyReads();";

let directory: string;
let probe: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-cold-start-"));
  probe = join(directory, "probe.mjs");
  // Counts reader releases and reports the count when the first HTTP request arrives.
  await writeFile(
    probe,
    `import dc from "node:diagnostics_channel";
const proto = ReadableStreamDefaultReader.prototype;
const release = proto.releaseLock;
let releases = 0;
proto.releaseLock = function () { releases++; return release.call(this); };
let reported = false;
dc.subscribe("http.server.request.start", () => {
  if (reported) return;
  reported = true;
  console.log("releases-before-first-request=" + releases);
});
`,
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/** Starts the built server under the probe, sends one request and returns the probe's count. */
async function releasesBeforeFirstRequest(file: string): Promise<number> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", probe, file], {
    env: await approvedTestEnvironment({
      PATH: process.env.PATH,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (data) => (out += String(data)));
  child.stderr.on("data", (data) => (err += String(data)));
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("API did not start")),
        15_000,
      );
      child.stdout.on("data", () => {
        if (out.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      void exited.then(() => {
        clearTimeout(timer);
        reject(new Error(`API exited: ${err}`));
      });
    });
    await (await fetch(`http://127.0.0.1:${port}/healthz`)).arrayBuffer();
    const match = /releases-before-first-request=(\d+)/.exec(out);
    if (!match) throw new Error(`probe did not report: ${out}`);
    return Number(match[1]);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

describe("API start-up warms the response cache's body read", () => {
  it("releases a web-stream reader before the first request arrives", async () => {
    expect(await readFile(server, "utf8")).toContain(WARM_UP);
    expect(await releasesBeforeFirstRequest(server)).toBeGreaterThan(0);
  });

  it("negative control: without the warm-up the first request is the first release", async () => {
    const original = await readFile(server, "utf8");
    expect(original).toContain(WARM_UP);
    const mutant = await plantMutantFile(server, original.replace(WARM_UP, ""));
    try {
      expect(await releasesBeforeFirstRequest(mutant.path)).toBe(0);
    } finally {
      await mutant.cleanup();
    }
  });
});
