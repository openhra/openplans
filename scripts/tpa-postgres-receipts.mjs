#!/usr/bin/env node
// End-to-end receipt proof against the disposable database prepared by census-realdata.mjs.
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createDatabase } from "../dist/db/database.js";
import { prepareIchraReceipt } from "../dist/receipts/ichra.js";
import { receiptDependencies } from "../dist/receipts/ichra.js";
import {
  verifyReceipt,
  canonicalJson,
  sha256,
} from "../dist/receipts/evidence.js";
import { fileSha256 } from "../dist/receipts/replay.js";

const url = process.env.DATABASE_URL;
assert(url, "DATABASE_URL is required");
const parsed = new URL(url);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname),
  "Postgres must be loopback",
);
assert(process.env.OPENPLANS_DATA_DIR, "OPENPLANS_DATA_DIR is required");
const root = resolve(process.env.OPENPLANS_DATA_DIR);
const work = join(root, "work/tpa2pg");
await mkdir(work, { recursive: true });
const scratch = await mkdtemp(join(work, "receipt-"));
const db = createDatabase(url);
const batch = {
  rows: Array.from({ length: 25 }, (_, i) => ({
    row: i + 1,
    input: {
      plan_start: i === 24 ? "2027-01-01" : "2026-01-01",
      employee: { date_of_birth: "1987-06-23" },
      residence: { county: "48201" },
      hra: { self_only_annual_cents: 987654321 },
      income: [{ measure: "household", annual_cents: 1234567891 }],
      safe_harbors: { look_back: i === 23 },
      lcsp_premium_basis: "gross",
    },
  })),
};
const oneRowStates = [
  ["FL", "12086"],
  ["NY", "36061"],
  ["GA", "13121"],
  ["VT", "50007"],
].map(([state, county]) => ({
  state,
  input: {
    rows: [
      {
        row: 1,
        input: {
          ...batch.rows[0].input,
          residence: { county },
        },
      },
    ],
  },
}));
const sentinels = ["1987-06-23", "1234567891", "987654321"];
const pct = (a) => {
  const x = [...a].sort((m, n) => m - n);
  return {
    p50_ms: x[Math.ceil(x.length * 0.5) - 1],
    p95_ms: x[Math.ceil(x.length * 0.95) - 1],
    runs: x.length,
  };
};
const ms = async (fn) => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};
try {
  const report = {
    synthetic_inputs: true,
    rows: 25,
    states: ["TX", "FL", "NY", "GA", "VT"],
    timing: {},
    controls: {},
    passed: false,
  };
  const deps = await receiptDependencies(db);
  const exportTimes = [];
  const receiptCases = [
    ...Array.from({ length: 4 }, () => ({ state: "TX", input: batch })),
    ...oneRowStates,
  ];
  for (let i = 0; i < 4; i++) {
    let receipt;
    exportTimes.push(
      await ms(async () => {
        receipt = await prepareIchraReceipt(
          db,
          batch,
          false,
          AbortSignal.timeout(15000),
        );
      }),
    );
    receiptCases[i].receipt = receipt;
  }
  for (let i = 4; i < receiptCases.length; i++) {
    let receipt;
    exportTimes.push(
      await ms(async () => {
        receipt = await prepareIchraReceipt(
          db,
          receiptCases[i].input,
          false,
          AbortSignal.timeout(15000),
        );
      }),
    );
    receiptCases[i].receipt = receipt;
  }
  report.receipt = receiptCases[0].receipt;
  const receiptPath = join(scratch, "receipt.json");
  const inputPath = join(scratch, "inputs.json");
  const filesPath = join(scratch, "files.json");
  const files = {};
  const leaves = report.receipt.provenance.snapshots.filter(
    (snapshot) => !snapshot.members,
  );
  const rawRoot = join(root, "raw");
  const rawDirectories = await readdir(rawRoot, { withFileTypes: true });
  const rawHashIndex = new Map();
  const indexMetadata = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (entry.name !== "meta.json" && !entry.name.endsWith(".meta.json"))
        continue;
      try {
        const metadata = JSON.parse(
          await readFile(join(folder, entry.name), "utf8"),
        );
        const payload =
          entry.name === "meta.json"
            ? join(folder, "payload")
            : join(folder, entry.name.slice(0, -".meta.json".length));
        if (
          metadata.sha256 &&
          (await access(payload).then(
            () => true,
            () => false,
          ))
        )
          rawHashIndex.set(metadata.sha256, payload);
      } catch {
        // An unrelated or unreadable metadata sidecar is not a candidate.
      }
    }
  };
  for (const directory of rawDirectories) {
    if (!directory.isDirectory()) continue;
    const folder = join(rawRoot, directory.name);
    await indexMetadata(folder);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (/^[a-f0-9]{64}$/.test(entry.name))
        rawHashIndex.set(
          entry.name,
          entry.isDirectory() ? join(path, "payload") : path,
        );
      if (entry.isDirectory()) await indexMetadata(path);
    }
  }
  for (const snapshot of report.receipt.provenance.snapshots) {
    if (snapshot.members) continue;
    const source = snapshot.source_id.split(":")[0];
    const sourceNames = [...new Set([source, source.replaceAll("_", "-")])];
    const candidates = sourceNames.flatMap((name) => [
      join(root, "raw", name, snapshot.sha256, "payload"),
      join(root, "raw", name, snapshot.sha256),
      join(root, "raw", name, snapshot.snapshot_id, "payload"),
      join(root, "raw", name, snapshot.snapshot_id),
    ]);
    candidates.push(join(root, "derived/state-rating/ny-2026.json.pre-nytpl"));
    for (const folder of [
      join(root, "derived/state-rating"),
      resolve("data/rating-rules"),
    ]) {
      try {
        for (const name of await readdir(folder))
          if (name.endsWith(".json")) candidates.push(join(folder, name));
      } catch {
        // Some optional local evidence directories are absent.
      }
    }
    for (const candidate of candidates) {
      try {
        await access(candidate);
        if ((await fileSha256(candidate)) === snapshot.sha256) {
          files[snapshot.snapshot_id] = candidate;
          break;
        }
      } catch {
        // A candidate can be absent or have a different content hash.
      }
    }
    if (!files[snapshot.snapshot_id] && rawHashIndex.has(snapshot.sha256)) {
      const candidate = rawHashIndex.get(snapshot.sha256);
      try {
        if ((await fileSha256(candidate)) === snapshot.sha256)
          files[snapshot.snapshot_id] = candidate;
      } catch {
        // A candidate can be absent or have a different content hash.
      }
    }
    if (
      !files[snapshot.snapshot_id] &&
      snapshot.source_id === "openplans-rating-rules-2026"
    ) {
      const repo = resolve("..");
      const commits = execFileSync(
        "git",
        [
          "log",
          "--all",
          "--format=%H",
          "--",
          "openplans/data/rating-rules/2026.json",
        ],
        { cwd: repo, encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const commit of commits) {
        try {
          const bytes = execFileSync(
            "git",
            ["show", `${commit}:openplans/data/rating-rules/2026.json`],
            { cwd: repo },
          );
          if (sha256(bytes) === snapshot.sha256) {
            const restored = join(scratch, `rules-${snapshot.sha256}.json`);
            await writeFile(restored, bytes);
            files[snapshot.snapshot_id] = restored;
            break;
          }
        } catch {
          // Older source snapshots may no longer exist in repository history.
        }
      }
    }
  }
  const missingFiles = leaves
    .filter((snapshot) => !files[snapshot.snapshot_id])
    .map(({ snapshot_id, source_id }) => `${source_id}/${snapshot_id}`);
  assert.deepEqual(
    missingFiles,
    [],
    `Cached restore bytes missing for ${missingFiles.length} snapshots`,
  );
  await writeFile(filesPath, JSON.stringify(files));
  const env = { ...process.env, OPENPLANS_REPLAY_DATABASE_URL: url };
  const replayTimes = [];
  for (let i = 0; i < receiptCases.length; i++) {
    await writeFile(receiptPath, JSON.stringify(receiptCases[i].receipt));
    await writeFile(inputPath, JSON.stringify(receiptCases[i].input));
    let result;
    replayTimes.push(
      await ms(async () => {
        result = spawnSync(
          process.execPath,
          [
            "dist/receipts/cli.js",
            receiptPath,
            "--inputs",
            inputPath,
            "--snapshots",
            filesPath,
            "--replay",
          ],
          { env, encoding: "utf8" },
        );
      }),
    );
    assert.equal(
      result.status,
      0,
      `CLI replay ${receiptCases[i].state} ${i + 1} failed: ${result.stdout}`,
    );
    assert.equal(JSON.parse(result.stdout).status, "verified");
  }
  const mutatedInput = structuredClone(batch);
  mutatedInput.rows[0].input.hra.self_only_annual_cents++;
  const changedInput = await verifyReceipt(report.receipt, {
    input: mutatedInput,
    dependencies: deps,
  });
  assert.equal(changedInput.reason, "input_digest_mismatch");
  const alteredRule = structuredClone(deps);
  alteredRule.rule_hash = "0".repeat(64);
  const changedRule = await verifyReceipt(report.receipt, {
    input: batch,
    dependencies: alteredRule,
  });
  assert.equal(changedRule.reason, "rule_hash_mismatch");
  const answerByte = structuredClone(report.receipt);
  answerByte.answer_json = answerByte.answer_json.replace(
    '"complete"',
    '"changed!"',
  );
  answerByte.receipt_digest = sha256(
    canonicalJson(
      Object.fromEntries(
        Object.entries(answerByte).filter(([k]) => k !== "receipt_digest"),
      ),
    ),
  );
  const changedAnswer = await verifyReceipt(answerByte, {
    input: batch,
    dependencies: deps,
  });
  assert.equal(changedAnswer.reason, "answer_digest_mismatch");
  const changedGeneration = structuredClone(deps);
  changedGeneration.generation += "-other";
  const generation = await verifyReceipt(report.receipt, {
    input: batch,
    dependencies: changedGeneration,
    snapshotHash: async (id) =>
      report.receipt.provenance.snapshots.find((s) => s.snapshot_id === id)
        ?.sha256,
  });
  assert.equal(generation.reason, "restored_generation_mismatch");
  report.controls = {
    changed_input: changedInput.reason,
    altered_rule_hash: changedRule.reason,
    changed_answer_byte: changedAnswer.reason,
    different_generation: generation.reason,
  };
  report.timing = { export: pct(exportTimes), replay: pct(replayTimes) };
  report.privacy = {
    explicit_input_bundle: false,
    raw_input_in_receipt_json: false,
  };
  report.privacy.raw_input_in_receipt_json = receiptCases.some(({ receipt }) =>
    sentinels.some((value) => JSON.stringify(receipt).includes(value)),
  );
  assert.equal(
    report.privacy.raw_input_in_receipt_json,
    false,
    "default export must omit raw input",
  );
  report.passed = true;
  report.receipt_count_by_state = Object.fromEntries(
    [...new Set(receiptCases.map(({ state }) => state))].map((state) => [
      state,
      receiptCases.filter((receiptCase) => receiptCase.state === state).length,
    ]),
  );
  const summary = { ...report };
  delete summary.receipt;
  delete summary.receipts;
  await writeFile(
    join(work, "receipts.json"),
    JSON.stringify(
      { ...summary, receipt_count: receiptCases.length },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        receipt: "caller-held synthetic artifact",
        receipts: `count=${receiptCases.length}`,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
  await rm(scratch, { recursive: true, force: true });
}
