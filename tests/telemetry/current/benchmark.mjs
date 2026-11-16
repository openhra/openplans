// Synthetic offline HTTP workload. No databases, sockets or external services.
// Run after building: node tests/telemetry/current/benchmark.mjs
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import assert from "node:assert/strict";
import { createApp } from "../../../dist/api/app.js";
import { configureTelemetry } from "../../../dist/telemetry/index.js";

// A one-millisecond asynchronous database reply models an offline local query.
const db = {
  async query() {
    await setTimeout(1);
    return { rows: [{ ok: 1 }], rowCount: 1 };
  },
};
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function sample(enabled, count) {
  configureTelemetry({ enabled: false });
  configureTelemetry({ enabled });
  const app = createApp(db);
  const latencies = [];
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const before = performance.now();
    const response = await app.request("/healthz");
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    latencies.push(performance.now() - before);
  }
  latencies.sort((a, b) => a - b);
  return {
    throughput: (count * 1000) / (performance.now() - started),
    p95: latencies[Math.ceil(count * 0.95) - 1],
  };
}
await sample(false, 300);
await sample(true, 300);
const off = [],
  on = [];
// Alternate ordering to reduce warmup and host drift bias.
for (let round = 0; round < 8; round++) {
  if (round % 2) {
    on.push(await sample(true, 500));
    off.push(await sample(false, 500));
  } else {
    off.push(await sample(false, 500));
    on.push(await sample(true, 500));
  }
}
configureTelemetry({ enabled: false });
const baseline = {
  throughput: median(off.map((row) => row.throughput)),
  p95: median(off.map((row) => row.p95)),
};
const collected = {
  throughput: median(on.map((row) => row.throughput)),
  p95: median(on.map((row) => row.p95)),
};
const regression = {
  throughputPercent: (1 - collected.throughput / baseline.throughput) * 100,
  p95Percent: (collected.p95 / baseline.p95 - 1) * 100,
};
console.log(
  JSON.stringify(
    {
      workload:
        "synthetic health HTTP, 1ms asynchronous query, response consumed, sequential, 8 alternating 500-operation rounds per mode",
      baseline,
      collected,
      regression,
    },
    null,
    2,
  ),
);
assert.ok(
  regression.throughputPercent <= 5,
  "throughput regression exceeds 5%",
);
assert.ok(regression.p95Percent <= 5, "p95 regression exceeds 5%");
console.log("PASS: telemetry off/on regression budget");
