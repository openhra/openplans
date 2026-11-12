// Classifies every filed minimum and maximum in the cached 2026 quarterly and 2027 monthly Part D
// archives, with each plan's benefit type from the cached PBP archive of the same year and its SNP
// code from the plan file. Also reads the cited PBP dictionary rows. Runs only when
// OPENPLANS_DATA_DIR holds those exact archives; nothing is downloaded.
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  boundRules,
  classifyBounds,
  loadBoundFile,
} from "../../../src/domain/medicare/part-d-cost/bounds.js";
import {
  decodeChannel,
  decodePlanRows,
  yearRules,
} from "../../../src/domain/medicare/part-d-cost/repository.js";
import { streamZipMember } from "../../../src/fetch/index.js";
import { archiveLimits } from "../../../src/ingest/medicare/sources.js";
import {
  cachedSpuf,
  spufChannels,
  spufTableRows,
} from "../../../src/ingest/medicare/spuf.js";
import type { SpufKind } from "../../../src/ingest/medicare/spuf.js";
import { memberText, tabTable } from "../../../src/ingest/medicare/tabular.js";
import { readXlsxRows } from "../../../src/ingest/xlsx/index.js";

interface Expected {
  kind: SpufKind;
  year: number;
  sha256: string;
  pbp: string;
  /** Channel cells with a nonzero bound, by class. */
  classes: Record<string, number>;
  /** Plans with an LIS-range bound. */
  lisPlans: number;
}
// Counts from a separate join of the raw SPUF and PBP text (pipe and tab split).
const archives: Expected[] = [
  {
    kind: "quarterly",
    year: 2026,
    sha256: "16315ea97f043eea8f8539dc2ac2d8343b8054890e12615953767a8b6688d82b",
    pbp: "1720048e668f6c9e4abc47c512e537c013600de12860d28aea4f8308b5e51de4",
    classes: { greater_of: 9, lis_range: 3561 },
    lisPlans: 128,
  },
  {
    kind: "monthly",
    year: 2027,
    sha256: "5f3bbe4e9ca29bce965403f3780d66452ec446cef5bf01fa050d3c6a990f053c",
    pbp: "6d8430e2ecb51acf3cc8547f12dd73506aa73f0dccf034cc3c3393868576ff47",
    classes: { lis_range: 2385 },
    lisPlans: 81,
  },
];

const dataDir = process.env.OPENPLANS_DATA_DIR;
const pbpPath = (sha: string) =>
  dataDir ? join(dataDir, "raw", "cms-medicare-pbp", sha, "payload") : "";
async function find(expected: Expected) {
  if (!dataDir || !existsSync(pbpPath(expected.pbp))) return null;
  const cached = await cachedSpuf(expected.kind, dataDir);
  return (
    cached.find(
      (entry) =>
        entry.metadata.sha256 === expected.sha256 &&
        entry.archive.year === expected.year,
    ) ?? null
  );
}
const located = await Promise.all(archives.map(find));
const key = (contract = "", plan = "", segment = "") =>
  `${contract.trim()}-${plan.trim()}-${segment.trim().padStart(3, "0")}`;

async function benefitTypes(path: string) {
  const table = await tabTable(
    memberText(path, "pbp_mrx.txt", archiveLimits.pbp, "windows-1252"),
  );
  const column = (name: string) =>
    table.header.findIndex((cell) => cell.trim().toLowerCase() === name);
  const [h, p, s, b] = [
    "pbp_a_hnumber",
    "pbp_a_plan_identifier",
    "segment_id",
    "mrx_benefit_type",
  ].map(column);
  const types = new Map<string, string>();
  for await (const row of table.rows)
    types.set(
      key(row.fields[h!], row.fields[p!], row.fields[s!]),
      (row.fields[b!] ?? "").trim(),
    );
  return types;
}

describe.each(
  archives.map((expected, i) => [expected.year, expected, i] as const),
)("bounds in the cached %i archives", (_year, expected, index) => {
  const cached = located[index];

  it.skipIf(!cached)(
    "fall in classes G and LIS only; none is unrecognised",
    async () => {
      const types = await benefitTypes(pbpPath(expected.pbp));
      const rules = yearRules(expected.year);
      const plans = new Map<
        string,
        { cells: Record<string, string>; source_row: number }[]
      >();
      for await (const row of spufTableRows(cached!.path, "plan")) {
        const id = key(
          row.values.CONTRACT_ID,
          row.values.PLAN_ID,
          row.values.SEGMENT_ID,
        );
        const list = plans.get(id) ?? [];
        list.push({ cells: row.values, source_row: row.rowNumber });
        plans.set(id, list);
      }
      const snp = new Map(
        [...plans].map(([id, rows]) => [
          id,
          decodePlanRows(
            "cache",
            rows.map((row) => ({
              ...row,
              formulary_id: row.cells.FORMULARY_ID!,
              suppressed: false,
            })),
            rules,
          ).special_needs_plan,
        ]),
      );
      const bounds = boundRules(expected.year)!;
      const classes: Record<string, number> = {};
      const lisPlans = new Set<string>();
      for await (const row of spufTableRows(cached!.path, "beneficiary_cost")) {
        const id = key(
          row.values.CONTRACT_ID,
          row.values.PLAN_ID,
          row.values.SEGMENT_ID,
        );
        const type = types.get(id);
        const plan = snp.get(id);
        for (const channel of spufChannels) {
          const cell = decodeChannel(row.values, channel);
          const found = classifyBounds(
            cell,
            {
              defined_standard: type === undefined ? "unknown" : type === "1",
              special_needs_plan:
                plan?.status === "value" ? plan.snp : "unknown",
            },
            bounds,
          );
          if (found.class === "none" || found.class === "not_offered") continue;
          const name =
            found.class === "unsettled"
              ? `unsettled:${found.reason}`
              : found.class;
          classes[name] = (classes[name] ?? 0) + 1;
          if (found.class === "lis_range") lisPlans.add(id);
          if (found.class === "greater_of") expect(id).toBe("H3664-017-000");
        }
      }
      expect(classes).toEqual(expected.classes);
      expect(lisPlans.size).toBe(expected.lisPlans);
    },
    600_000,
  );

  it.skipIf(!cached)(
    "cite dictionary rows that say what the rules quote",
    async () => {
      const file = loadBoundFile().years[String(expected.year)]!;
      const citations = [
        ...file.greaterOf.citations,
        ...file.lesserOf.citations,
        ...file.definedStandard.citations,
      ];
      const member = citations[0]!.member!;
      const directory = await mkdtemp(join(tmpdir(), "openplans-pbp-bounds-"));
      try {
        const path = join(directory, "dictionary.xlsx");
        await pipeline(
          Readable.from(
            streamZipMember(pbpPath(expected.pbp), member, archiveLimits.pbp),
          ),
          createWriteStream(path, { flags: "wx" }),
        );
        const rows: string[][] = [];
        for await (const row of readXlsxRows(path, { maxRows: 200_000 }))
          rows.push(row);
        const fieldOf = (row: number) => {
          // Continuation rows leave FILE and NAME blank; the field is on the nearest row above.
          for (let at = row; at >= 1; at--) {
            const cells = rows[at - 1]!;
            if ((cells[1] ?? "").trim())
              return `${cells[0]!.trim()}.${cells[1]!.trim()}`;
          }
          return "";
        };
        expect(rows[0]!.slice(0, 4)).toEqual([
          "FILE",
          "NAME",
          "TYPE",
          "LENGTH",
        ]);
        for (const citation of citations) {
          const cells = rows[citation.row! - 1]!;
          expect(citation.member).toBe(member);
          expect(`${cells[8]} ${cells[9]}`.trim()).toBe(citation.quote);
          expect(citation.section).toContain(fieldOf(citation.row!));
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
