import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { compareRawDrugFacts } from "../../scripts/oracle/raw-evidence.mjs";

it("compares sampled public drug facts and rejects nullable PA/tier mutations without a reference archive (synthetic)", () => {
  const row = {
    rxcui: "synthetic-concept",
    base_hios_id: "synthetic-plan",
    plan_year: 2026,
    facts: [["GENERIC", null, false, null]],
  };
  const raw = new Map([
    [JSON.stringify([row.rxcui, row.base_hios_id, row.plan_year]), row.facts],
  ]);
  expect(compareRawDrugFacts([row], raw).passed).toBe(true);
  for (const change of [
    [0, "INVENTED"],
    [1, false],
    [2, true],
  ]) {
    const mutant = structuredClone(row);
    mutant.facts[0][change[0]] = change[1];
    expect(compareRawDrugFacts([mutant], raw).passed).toBe(false);
  }
  expect(compareRawDrugFacts([row], new Map()).passed).toBe(false);
  expect(compareRawDrugFacts([], raw).passed).toBe(false);
});

it("independently projects a complete public provider feed, hashes its bytes and catches missing duplicate edges and truncation (synthetic)", async () => {
  const root = await mkdtemp(join(tmpdir(), "openplans-public-raw-"));
  try {
    const current = join(root, "synthetic-providers.json"),
      actual = join(root, "actual.jsonl"),
      output = join(root, "result.json");
    const row = {
      npi: "1003000126",
      plans: [{ plan_id: "76589TX0010015", years: [2026] }],
    };
    const payload = JSON.stringify([row, row]) + "\n";
    await writeFile(current, payload);
    const run = () =>
      spawnSync(
        "python3",
        [
          "-B",
          "scripts/oracle/provider_raw.py",
          "--current",
          current,
          "--actual",
          actual,
          "--output",
          output,
        ],
        { encoding: "utf8" },
      );
    await writeFile(
      actual,
      JSON.stringify([row.npi, row.plans[0].plan_id, 2]) + "\n",
    );
    expect(run().status).toBe(0);
    const valid = JSON.parse(await readFile(output, "utf8"));
    expect(valid.passed).toBe(true);
    expect(valid.source.sha256).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );
    expect(valid.negative_controls[0].passed).toBe(true);
    await writeFile(
      actual,
      JSON.stringify([row.npi, row.plans[0].plan_id, 1]) + "\n",
    );
    expect(run().status).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).passed).toBe(false);
    await writeFile(current, payload.slice(0, -3));
    expect(run().status).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
