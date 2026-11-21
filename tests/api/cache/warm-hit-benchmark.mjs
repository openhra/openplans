// Synthetic offline warm-hit workload. No databases, sockets or external services.
// Run after building: node tests/api/cache/warm-hit-benchmark.mjs [label]
// Pin it to one CPU as the image runs (Linux: taskset -c 0 node ...).
//
// Measures a response-cache hit end to end through the cache middleware, with the configuration
// in a file (OPENPLANS_CONFIG) as in the image, and the per-request disclosure scope mounted
// after the cache as createApp mounts it. Also times one configuration load for scale.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { createResponseCache } from "../../../dist/api/cache/index.js";
import { MemoryCache } from "../../../dist/api/cache/store.js";
import { loadConfig } from "../../../dist/config/index.js";
import { upstreamDisclosure } from "../../../dist/api/upstream.js";

const directory = mkdtempSync(join(tmpdir(), "openplans-warm-hit-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const file = join(directory, "config.json");
writeFileSync(
  file,
  JSON.stringify({ version: 1, rxnavIdentity: true, cmsFallback: {} }),
);
process.env.OPENPLANS_CONFIG = file;
process.env.OPENPLANS_RXNAV_IDENTITY = "on";

// Synthetic generation rows only, answered synchronously like a warm local pool.
const db = {
  query: async (sql) => ({
    rows:
      sql.includes("FROM annual_data_admission") || sql.includes("AS domain")
        ? []
        : [{ generation: "synthetic-generation" }],
  }),
};
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function build(disclosure) {
  const cache = createResponseCache(db, "synthetic-token", {
    store: new MemoryCache(1024 * 1024),
  });
  const app = new Hono();
  app.use("*", cache.middleware);
  if (disclosure) app.use("*", upstreamDisclosure);
  app.get("/v1/zip-counties", (c) =>
    c.json({ synthetic: true, counties: ["00000"] }),
  );
  return app;
}
const path = "/v1/zip-counties?zip=00000";

async function sample(app, count) {
  const latencies = [];
  for (let i = 0; i < count; i++) {
    const before = performance.now();
    const response = await app.request(path);
    assert.equal(response.headers.get("X-Cache"), "hit");
    await response.arrayBuffer();
    latencies.push((performance.now() - before) * 1000);
  }
  return median(latencies);
}

const arms = { disclosure: build(true), bare: build(false) };
for (const app of Object.values(arms)) {
  assert.equal((await app.request(path)).headers.get("X-Cache"), "miss");
  await sample(app, 500);
}
const results = { disclosure: [], bare: [] };
// Alternate ordering to reduce warmup and host drift bias.
for (let round = 0; round < 10; round++) {
  const order = round % 2 ? ["bare", "disclosure"] : ["disclosure", "bare"];
  for (const name of order) results[name].push(await sample(arms[name], 500));
}
for (let i = 0; i < 200; i++) loadConfig();
const loads = [];
for (let i = 0; i < 2000; i++) {
  const before = performance.now();
  loadConfig();
  loads.push((performance.now() - before) * 1000);
}
console.log(
  JSON.stringify({
    label: process.argv[2] ?? "current",
    warm_hit_p50_us: median(results.disclosure),
    warm_hit_p50_us_without_disclosure_middleware: median(results.bare),
    load_config_p50_us: median(loads),
  }),
);
