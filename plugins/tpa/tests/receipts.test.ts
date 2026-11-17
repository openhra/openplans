import type * as Crypto from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  serializeEvidence,
  verifyReceipt,
  sha256,
  canonicalJson,
} from "../../../src/receipts/evidence.js";
import type { Receipt } from "../../../src/receipts/evidence.js";
import {
  receiptDependencies,
  prepareIchraReceipt,
} from "../../../src/receipts/ichra.js";
import { replayExport } from "../../../src/receipts/replay.js";
import { receiptCli, localReplayUrl } from "../../../src/receipts/cli.js";
import {
  censusRows,
  ichraAffordabilityBatch,
} from "../../../src/services/ichra-batch.js";
import { setup, TOKEN } from "../../../tests/compat/v1/helpers.js";
import { loadConfig } from "../../../src/config/index.js";
import { loadPlugins } from "../../../src/plugins/loader.js";
import { createApp } from "../../../src/api/app.js";
import { PREPARE_PATH } from "../src/index.js";

// A repeatable synthetic import ID lets independent imports retain the pinned snapshot identities.
const importIds = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof Crypto>();
  return {
    ...original,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++importIds.next).padStart(12, "0")}`,
  };
});

// SYNTHETIC employees; the database uses unmodified public fixture files.
const employee = (extra = {}) => ({
  plan_start: "2026-01-01",
  employee: { date_of_birth: "1985-10-01" },
  residence: { zip: "77002" },
  hra: { self_only_annual_cents: 312789 },
  income: [{ measure: "household", annual_cents: 4118923 }],
  ...extra,
});
const request = (inputs = [employee()]) => ({
  rows: inputs.map((input, index) => ({ row: index + 1, input })),
});
const signal = () => new AbortController().signal;
const clone = <T>(value: T): T => structuredClone(value);
const resultLine = (value: string) => JSON.parse(value) as { reason: string };
let h: Awaited<ReturnType<typeof setup>>;
let restored: Awaited<ReturnType<typeof setup>>;
let directory: string;
beforeAll(async () => {
  vi.stubEnv("OPENPLANS_CMS_FALLBACK", "off");
  directory = await mkdtemp(join(tmpdir(), "openplans-answer-receipts-"));
  importIds.next = 0;
  h = await setup();
  importIds.next = 0;
  restored = await setup();
  // Restore the original cache-generation record as a logical backup would. New databases
  // intentionally have a distinct identity even when their public files are identical.
  const { rows: generations } = await h.db.query<{
    table_name: string;
    revision: string;
  }>("SELECT table_name,revision::text FROM api_data_generation");
  await restored.db.exec("TRUNCATE api_data_generation");
  for (const row of generations)
    await restored.db.query(
      "INSERT INTO api_data_generation(table_name,revision) VALUES($1,$2)",
      [row.table_name, row.revision],
    );
});
afterAll(async () => {
  await h?.close();
  await restored?.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("exports exact answer bytes, excludes raw inputs by default, and uses random IDs", async () => {
  const body = request();
  const answer = await ichraAffordabilityBatch(
    h.db,
    censusRows(body),
    signal(),
  );
  const receipt = await prepareIchraReceipt(h.db, body, false, signal());
  expect(receipt.answer_json).toBe(JSON.stringify(answer));
  expect(receipt).not.toHaveProperty("input_bundle");
  expect(JSON.stringify(receipt)).not.toContain("4118923");
  expect(receipt.receipt_id).not.toBe(
    (await prepareIchraReceipt(h.db, body, false, signal())).receipt_id,
  );
  expect(receipt.retention).toBe("caller_download_only");
  expect(receipt.provenance.snapshots.length).toBeGreaterThan(0);
});

it("reproduces 100 synthetic row answers in four capped exports on independently restored public fixtures", async () => {
  const cases = [
    {},
    { residence: { zip: "33101" } },
    { residence: { zip: "10001" } },
    { plan_start: "2027-01-01" },
    { plan_start: "2026-07-01", safe_harbors: { look_back: true } },
    {
      safe_harbors: { look_back: true },
      income: [{ measure: "w2", annual_cents: 4118923 }],
    },
    {
      months_available: 6,
      employee: { date_of_birth: "1985-10-01", eligible_from: "2026-07-01" },
      income: [
        {
          measure: "w2",
          annual_cents: 2118923,
          w2_months_offered: 6,
          w2_months_employed: 9,
        },
      ],
    },
    {
      income: [
        {
          measure: "rate_of_pay_salary",
          monthly_cents: 311892,
          salary_reduced: true,
        },
      ],
    },
    { lcsp_premium_basis: "ehb_portion" },
    { lcsp_premium_basis: "gross" },
    { residence: { zip: "77494" } },
    { residence: { county: "48201" } },
  ];
  const inputs = Array.from({ length: 100 }, (_, index) =>
    employee({
      hra: { self_only_annual_cents: 300000 + index },
      ...cases[index % cases.length],
    }),
  );
  let equal = 0;
  let unresolved = 0;
  for (let offset = 0; offset < 100; offset += 25) {
    const body = request(inputs.slice(offset, offset + 25));
    const receipt = await prepareIchraReceipt(h.db, body, true, signal());
    const answer = await ichraAffordabilityBatch(
      restored.db,
      censusRows(body),
      signal(),
    );
    expect(sha256(JSON.stringify(answer))).toBe(sha256(receipt.answer_json));
    for (let i = 0; i < body.rows.length; i++) {
      const single = await restored.app.request("/v1/ichra/affordability", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify(body.rows[i]!.input),
      });
      expect(single.status).toBe(200);
      const row = answer.rows[i]!;
      expect("result" in row && sha256(JSON.stringify(row.result))).toBe(
        sha256(await single.text()),
      );
      equal++;
      if (row.status !== "calculated") unresolved++;
    }
    const { rows: paths } = await restored.db.query<{
      snapshot_id: string;
      raw_path: string;
    }>(
      "SELECT snapshot_id,raw_path FROM snapshot WHERE validation_state='ACTIVE' AND raw_path IS NOT NULL",
    );
    const files = Object.fromEntries(
      paths.map((row) => [row.snapshot_id, row.raw_path]),
    );
    const result = await replayExport(receipt, undefined, files, restored.db);
    expect(result).toEqual({ status: "verified", reason: "answer_reproduced" });
  }
  expect(equal).toBe(100);
  expect(unresolved).toBeGreaterThan(0); // States and years outside this fixture remain unknown.
  process.stdout.write(
    `receipt sample: equal=${equal}/100 unresolved=${unresolved}\n`,
  );
}, 30_000);

it("rejects each required tamper control, including a freshly rehashed manifest with a changed rule", async () => {
  const body = request();
  const receipt = await prepareIchraReceipt(h.db, body, true, signal());
  const dependencies = await receiptDependencies(h.db);
  const options = {
    dependencies,
    snapshotHash: async (id: string) =>
      receipt.provenance.snapshots.find((s) => s.snapshot_id === id)?.sha256,
    replay: (input: unknown) =>
      ichraAffordabilityBatch(h.db, censusRows(input), signal()),
  };
  expect((await verifyReceipt(receipt, options)).status).toBe("verified");
  const changedInput = request([
    employee({ hra: { self_only_annual_cents: 312790 } }),
  ]);
  expect(
    await verifyReceipt(receipt, { ...options, input: changedInput }),
  ).toEqual({ status: "failed", reason: "input_digest_mismatch" });
  expect(
    await verifyReceipt(receipt, {
      ...options,
      snapshotHash: async () => undefined,
    }),
  ).toEqual({ status: "unavailable", reason: "snapshot_missing" });
  expect(
    await verifyReceipt(receipt, {
      ...options,
      snapshotHash: async () => "0".repeat(64),
    }),
  ).toEqual({ status: "failed", reason: "snapshot_hash_mismatch" });
  const rule = clone(receipt);
  rule.provenance.rule_hash = "0".repeat(64);
  const { receipt_digest: _digest, ...payload } = rule;
  rule.receipt_digest = sha256(canonicalJson(payload));
  expect(await verifyReceipt(rule, options)).toEqual({
    status: "failed",
    reason: "rule_hash_mismatch",
  });
  const answer = clone(receipt);
  answer.answer_json += " ";
  expect((await verifyReceipt(answer, options)).status).toBe("failed");
  const { receipt_digest: _answerDigest, ...changedAnswerPayload } = answer;
  answer.receipt_digest = sha256(canonicalJson(changedAnswerPayload));
  expect((await verifyReceipt(answer, options)).reason).toBe(
    "answer_digest_mismatch",
  );
  expect(
    (await verifyReceipt(receipt, { ...options, input: null })).reason,
  ).toBe("input_digest_mismatch");
  expect(
    await verifyReceipt(receipt, {
      ...options,
      replay: async () => ({ changed: true }),
    }),
  ).toEqual({ status: "failed", reason: "replayed_answer_mismatch" });
  const rehashed = serializeEvidence(
    body,
    { changed: true },
    dependencies,
    true,
  );
  expect((await verifyReceipt(rehashed, options)).reason).toBe(
    "replayed_answer_mismatch",
  );
});

it("reports absent inputs, engine, snapshots, generation and replay adapter explicitly", async () => {
  const receipt = await prepareIchraReceipt(h.db, request(), false, signal());
  expect((await verifyReceipt(receipt)).reason).toBe("inputs_required");
  expect((await verifyReceipt(receipt, { input: request() })).reason).toBe(
    "engine_and_rules_required",
  );
  const deps = clone(receipt.provenance);
  deps.engine.version = "unavailable-build";
  expect(
    (await verifyReceipt(receipt, { input: request(), dependencies: deps }))
      .reason,
  ).toBe("engine_version_unavailable");
  expect((await replayExport(receipt, request(), {})).reason).toBe(
    "snapshot_missing",
  );
});

it("CLI hashes actual local file bytes, fails changed bytes, and reports replay unavailable without a database", async () => {
  const path = join(directory, "public-file");
  await writeFile(path, "synthetic public snapshot\n");
  const deps = await receiptDependencies(h.db);
  deps.snapshots = [
    {
      snapshot_id: "synthetic-file",
      source_id: "synthetic",
      sha256: sha256(await readFile(path)),
    },
  ];
  const receipt = serializeEvidence(
    request(),
    { example: "synthetic answer" },
    deps,
    true,
  );
  const receiptPath = join(directory, "receipt.json");
  const filesPath = join(directory, "files.json");
  await writeFile(receiptPath, JSON.stringify(receipt));
  await writeFile(filesPath, JSON.stringify({ "synthetic-file": path }));
  const lines: string[] = [];
  const run = () =>
    receiptCli([receiptPath, "--snapshots", filesPath], {}, (line) =>
      lines.push(line),
    );
  expect(await run()).toBe(2);
  expect(resultLine(lines.pop()!).reason).toBe("replay_adapter_required");
  await writeFile(path, "synthetic public snapshot!\n");
  expect(await run()).toBe(1);
  expect(resultLine(lines.pop()!).reason).toBe("snapshot_hash_mismatch");
  expect(await receiptCli([], {}, (line) => lines.push(line))).toBe(2);
  expect(() => localReplayUrl("postgres://example.test/restored")).toThrow();
  expect(() =>
    localReplayUrl("postgres://localhost/restored?host=example.test"),
  ).toThrow();
  expect(localReplayUrl("postgres://127.0.0.1/restored")).toBe(
    "postgres://127.0.0.1/restored",
  );
});

async function pluginApp(
  tpa = { enabled: true, privateIngress: true },
  token: string | null = "synthetic-receipt-token",
) {
  const env = token ? { OPENPLANS_OPERATOR_TOKEN: token } : {};
  const config = loadConfig(env, {
    version: 1,
    tpa,
    plugins: [
      { package: fileURLToPath(new URL("../src/index.ts", import.meta.url)) },
    ],
  });
  const loaded = await loadPlugins(config, "api", {
    env,
    writeLog: () => {},
    exit: () => {
      throw new Error("plugin_load_failed");
    },
  });
  const app = createApp(h.db, { tpa }, { config, plugins: loaded.registries });
  return { app, loaded };
}
const send = (
  app: ReturnType<typeof createApp>,
  body: unknown,
  token = "synthetic-receipt-token",
) =>
  app.request(PREPARE_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
it("loads only for private opt-in, requires operator auth, exports without persistence, and has no lookup", async () => {
  for (const flags of [
    { enabled: false, privateIngress: true },
    { enabled: true, privateIngress: false },
  ]) {
    const { app, loaded } = await pluginApp(flags);
    expect((await send(app, {})).status).toBe(404);
    expect(loaded.registries.routes).toHaveLength(0);
    await loaded.teardown();
  }
  const { app, loaded } = await pluginApp();
  const body = { operation: "prepare_from_batch", batch_request: request() };
  try {
    expect(loaded.registries.mcpTools).toHaveLength(0);
    expect(loaded.registries.schedules).toHaveLength(0);
    expect((await send(app, body, "wrong")).status).toBe(401);
    const query = vi.spyOn(h.db, "query");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await send(app, body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const receipt = (await response.json()) as Receipt;
    expect(receipt).not.toHaveProperty("input_bundle");
    expect(
      (await app.request(`${PREPARE_PATH}/${receipt.receipt_id}`)).status,
    ).toBe(404);
    expect(
      query.mock.calls.every(
        ([sql]) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql),
      ),
    ).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("4118923");
    query.mockRestore();
    log.mockRestore();
    const invalid = await send(app, {
      ...body,
      batch_request: request([
        employee({
          employee: {
            date_of_birth: "1985-10-01",
            name: "synthetic-private-sentinel",
          },
        }),
      ]),
    });
    expect(invalid.status).toBe(200);
    const invalidReceipt = (await invalid.json()) as Receipt;
    const invalidAnswer = JSON.parse(invalidReceipt.answer_json) as {
      rows: { status: string }[];
    };
    expect(invalidAnswer.rows[0]?.status).toBe("invalid");
    expect(JSON.stringify(invalidReceipt)).not.toContain(
      "synthetic-private-sentinel",
    );
    expect(
      (await send(app, { ...body, employer_name: "synthetic" })).status,
    ).toBe(400);
    expect(
      (
        await send(app, {
          ...body,
          batch_request: request(Array.from({ length: 26 }, () => employee())),
        })
      ).status,
    ).toBe(400);
  } finally {
    await loaded.teardown();
  }
  const noToken = await pluginApp(undefined, null);
  expect((await send(noToken.app, body)).status).toBe(404);
  await noToken.loaded.teardown();
});

it("rejects a missing aggregate member and refuses a different restored generation", async () => {
  const body = request();
  const receipt = await prepareIchraReceipt(h.db, body, true, signal());
  const dependencies = await receiptDependencies(h.db);
  const options = {
    dependencies,
    snapshotHash: async (id: string) =>
      receipt.provenance.snapshots.find(
        (snapshot) => snapshot.snapshot_id === id,
      )?.sha256,
    replay: (input: unknown) =>
      ichraAffordabilityBatch(h.db, censusRows(input), signal()),
  };
  const changed = clone(dependencies);
  changed.generation = "different-restored-generation";
  expect(
    (await verifyReceipt(receipt, { ...options, dependencies: changed }))
      .reason,
  ).toBe("restored_generation_mismatch");
  const broken = clone(receipt);
  const aggregate = broken.provenance.snapshots.find(
    (snapshot) => snapshot.members,
  );
  expect(aggregate).toBeDefined();
  broken.provenance.snapshots = broken.provenance.snapshots.filter(
    (snapshot) => snapshot.snapshot_id !== aggregate!.members![0]!.snapshot_id,
  );
  const { receipt_digest: _digest, ...payload } = broken;
  broken.receipt_digest = sha256(canonicalJson(payload));
  expect((await verifyReceipt(broken, options)).reason).toBe(
    "snapshot_manifest_member_missing",
  );
});
