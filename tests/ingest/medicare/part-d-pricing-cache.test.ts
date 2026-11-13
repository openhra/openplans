// Cache-only check of unit costs and dispensing-fee ranges on real rows. Runs only when
// OPENPLANS_DATA_DIR holds the 2026 Q3 quarterly archive with this exact hash; nothing is
// downloaded. A hash-selected sample of plans is read from the raw member text with `unzip -p`
// and `funzip`, sharing no code with the importer. Those raw lines are imported unchanged, and
// every answer must equal the value written in the raw text.
import { PGlite } from "@electric-sql/pglite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../src/db/migrate.js";
import type { Database } from "../../../src/db/database.js";
import {
  readDispensingFeeRanges,
  readUnitCost,
} from "../../../src/domain/medicare/part-d-cost/repository.js";
import type { SpufChannel } from "../../../src/ingest/medicare/spuf.js";
import { cachedSpuf, importSpuf } from "../../../src/ingest/medicare/spuf.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { zip } from "./helpers.js";

const SHA256 =
  "16315ea97f043eea8f8539dc2ac2d8343b8054890e12615953767a8b6688d82b";
const PRICING_MEMBER = "pricing file PPUF_2026Q3.zip";
// The smallest of the six network members; its plans are not in the other members.
const NETWORK_MEMBER = "pharmacy networks file  PPUF_2026Q3 part 6.zip";
const PRICING_MODULUS = 500n;
const NETWORK_MODULUS = 100n;

const dataDir = process.env.OPENPLANS_DATA_DIR;
const located = dataDir
  ? ((await cachedSpuf("quarterly", dataDir)).find(
      (entry) => entry.metadata.sha256 === SHA256,
    ) ?? null)
  : null;

const selected = (key: string, modulus: bigint) =>
  BigInt(`0x${createHash("sha256").update(key).digest("hex")}`) % modulus ===
  0n;

/** Header and the raw lines of sampled plans, read straight from the member text. */
async function rawSample(path: string, name: string, modulus: bigint) {
  const unzip = spawn("unzip", ["-p", path, name], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const funzip = spawn("funzip", [], { stdio: ["pipe", "pipe", "inherit"] });
  unzip.stdout.pipe(funzip.stdin);
  const lines = createInterface({ input: funzip.stdout, crlfDelay: Infinity });
  let header = "";
  const kept: string[] = [];
  let previous = "",
    keep = false;
  for await (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!header) {
      header = line;
      continue;
    }
    if (!line) continue;
    const key = line.split("|", 3).join("-");
    if (key !== previous) {
      previous = key;
      keep = selected(key, modulus);
    }
    if (keep) kept.push(line);
  }
  return { header, lines: kept };
}

describe.skipIf(!located)("real 2026 Q3 unit costs and fee ranges", () => {
  let directory: string;
  let db: Database;
  let cleanup: () => Promise<void>;
  let snapshotId: string;
  let pricing: { header: string; lines: string[] };
  let network: { header: string; lines: string[] };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "partd-pricing-cache-"));
    pricing = await rawSample(located!.path, PRICING_MEMBER, PRICING_MODULUS);
    network = await rawSample(located!.path, NETWORK_MEMBER, NETWORK_MODULUS);
    const text = (sample: { header: string; lines: string[] }) =>
      Buffer.from([sample.header, ...sample.lines, ""].join("\r\n"), "latin1");
    const subset = join(directory, "subset.zip");
    await writeFile(
      subset,
      zip({
        [PRICING_MEMBER]: zip({
          "pricing file PPUF_2026Q3.txt": text(pricing),
        }),
        [NETWORK_MEMBER]: zip({
          "pharmacy networks file  PPUF_2026Q3 part 6.txt": text(network),
        }),
      }),
    );
    const migrations = await coreMigrations();
    db = testDatabase(new PGlite());
    cleanup = async () => {
      await db.close();
      await migrations.cleanup();
    };
    await migrate(db, migrations.directory);
    const imported = await importSpuf(
      db,
      {
        ...located!,
        path: subset,
        metadata: {
          ...located!.metadata,
          sha256: createHash("sha256")
            .update(await readFile(subset))
            .digest("hex"),
          bytes: (await stat(subset)).size,
        },
      },
      ["pricing", "dispensing_fee"],
    );
    snapshotId = imported.snapshot_id;
  }, 900_000);
  afterAll(async () => {
    await cleanup?.();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reads the published header, including the selected-drug fee spelling", () => {
    expect(pricing.header).toBe(
      "CONTRACT_ID|PLAN_ID|SEGMENT_ID|NDC|DAYS_SUPPLY|UNIT_COST",
    );
    expect(network.header.split("|").slice(-3)).toEqual([
      "SELECTED_DISPENSING_FEE_30",
      "SELECTED_DISPENSING_FEE_60",
      "SELECTED_DISPENSING_FEE_90",
    ]);
  });

  it("answers each sampled exact row with the raw unit cost and its row number", async () => {
    const plans = new Set(pricing.lines.map((l) => l.split("|", 3).join("-")));
    expect(plans.size).toBeGreaterThan(3);
    // Every 50th raw row, plus each sampled (plan, NDC) at all three days supplies.
    const byGroup = new Map<string, Map<number, [string, number]>>();
    pricing.lines.forEach((line, index) => {
      const [c, p, s, ndc, days, cost] = line.split("|");
      const group = `${c}|${p}|${s}|${ndc}`;
      if (!byGroup.has(group)) byGroup.set(group, new Map());
      byGroup.get(group)!.set(Number(days), [cost!, index + 2]);
    });
    const groups = [...byGroup.entries()].filter((_, i) => i % 50 === 0);
    expect(groups.length).toBeGreaterThan(100);
    let values = 0,
      missing = 0;
    for (const [group, rows] of groups) {
      const [contractId, planId, segment, ndc] = group.split("|");
      for (const days of [30, 60, 90]) {
        const answer = await readUnitCost(db, {
          snapshotId,
          year: 2026,
          plan: {
            contractId: contractId!,
            planId: planId!,
            segmentId: String(Number(segment)),
          },
          ndc: ndc!,
          daysSupply: days,
          channel: "preferred_retail",
          quantityUnit: "ndc_unit",
        });
        const raw = rows.get(days);
        if (!raw) {
          missing++;
          expect(answer).toMatchObject({
            status: "unknown",
            reason: "unit_cost_not_published",
          });
        } else if (Number(raw[0]) === 0) {
          expect(answer).toMatchObject({
            status: "unknown",
            reason: "unit_cost_unreadable",
          });
        } else {
          values++;
          if (answer.status !== "value")
            throw new Error(`${group} ${days}: ${JSON.stringify(answer)}`);
          // Compared as decimal text: the raw cell padded to four places.
          const [whole, fraction = ""] = raw[0].split(".");
          expect(answer.unit_cost).toBe(`${whole}.${fraction.padEnd(4, "0")}`);
          expect(answer.evidence.source_row).toBe(raw[1]);
        }
      }
    }
    expect(values).toBeGreaterThan(200);
    expect(missing).toBeGreaterThanOrEqual(0);
  });

  it("gives the lowest and highest raw in-area fee per plan, channel, type and days supply", async () => {
    const header = network.header.split("|");
    const at = (name: string) => header.indexOf(name);
    type Expected = {
      min: number;
      max: number;
      readable: number;
      missing: number;
    };
    const expected = new Map<string, Expected>();
    for (const line of network.lines) {
      const cells = line.split("|");
      if (cells[at("IN_AREA_FLAG")] !== "1") continue;
      const channels: string[] = [];
      if (cells[at("PHARMACY_RETAIL")] === "Y")
        channels.push(
          cells[at("PREFERRED_STATUS_RETAIL")] === "Y"
            ? "preferred_retail"
            : "standard_retail",
        );
      if (cells[at("PHARMACY_MAIL")] === "Y")
        channels.push(
          cells[at("PREFERRED_STATUS_MAIL")] === "Y"
            ? "preferred_mail"
            : "standard_mail",
        );
      for (const channel of channels)
        for (const [type, prefix] of [
          ["brand", "BRAND"],
          ["generic", "GENERIC"],
          ["selected", "SELECTED"],
        ])
          for (const days of [30, 60, 90]) {
            const id = `${cells.slice(0, 3).join("-")}|${channel}|${type}|${days}`;
            const cell = cells[at(`${prefix}_DISPENSING_FEE_${days}`)]!;
            const entry = expected.get(id) ?? {
              min: Infinity,
              max: -Infinity,
              readable: 0,
              missing: 0,
            };
            if (cell === "." || cell === "") entry.missing++;
            else {
              entry.readable++;
              entry.min = Math.min(entry.min, Number(cell));
              entry.max = Math.max(entry.max, Number(cell));
            }
            expected.set(id, entry);
          }
    }
    const plans = [
      ...new Set([...expected.keys()].map((id) => id.split("|")[0]!)),
    ];
    expect(plans.length).toBeGreaterThan(2);
    let compared = 0;
    for (const key of plans) {
      const [contractId, planId, segment] = key.split("-");
      for (const channel of [
        "preferred_retail",
        "standard_retail",
        "preferred_mail",
        "standard_mail",
      ] as SpufChannel[])
        for (const days of [30, 60, 90]) {
          const answer = await readDispensingFeeRanges(db, {
            snapshotId,
            year: 2026,
            plan: {
              contractId: contractId!,
              planId: planId!,
              segmentId: String(Number(segment)),
            },
            daysSupply: days,
            channel,
          });
          const types = ["brand", "generic", "selected"].filter((t) =>
            expected.has(`${key}|${channel}|${t}|${days}`),
          );
          if (!types.length) {
            expect(answer).toEqual({
              status: "unknown",
              reason: "no_in_area_network_pharmacy",
            });
            continue;
          }
          if (answer.status !== "value")
            throw new Error(JSON.stringify(answer));
          expect(answer.ranges.map((r) => r.fee_type)).toEqual(types);
          for (const range of answer.ranges) {
            const want = expected.get(
              `${key}|${channel}|${range.fee_type}|${days}`,
            )!;
            expect([range.fees_readable, range.fees_missing]).toEqual([
              want.readable,
              want.missing,
            ]);
            if (want.readable === 0)
              expect([range.min_fee, range.max_fee]).toEqual([null, null]);
            else
              expect([range.min_fee, range.max_fee]).toEqual([
                want.min.toFixed(4),
                want.max.toFixed(4),
              ]);
            expect(range.evidence.source_files).toEqual([NETWORK_MEMBER]);
            compared++;
          }
        }
    }
    expect(compared).toBeGreaterThan(20);
  });
});
