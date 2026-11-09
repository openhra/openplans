import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/api/app.js";
import type { SqlSession } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { importSbe } from "../../src/ingest/sbe/import.js";
import { ingestSbeGeography } from "../../src/ingest/sbe/geography.js";
import type { GeoFiles } from "../../src/ingest/geo/sources.js";
import type { ImportFile } from "../../src/ingest/puf/import-source.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import * as medicalPolicy from "../../src/domain/rating/medical-policy.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { caExamples } from "../domain/rating/ca-helpers.js";

const token = "synthetic-ca-premium-token";
const root = fileURLToPath(
  new URL("../fixtures/rating/ca-2026/", import.meta.url),
);
const db = testDatabase(new PGlite());
let directory: string, migration: Awaited<ReturnType<typeof coreMigrations>>;
let manifest: {
  url: string;
  sourceSha256: string;
  files: { member: string; sourceRows: number[]; cutSha256: string }[];
};
let rateSnapshot: string;
const names = [
  "CAPlans05052026.csv",
  "CAServiceAreas05052026.csv",
  "CANetworks05052026.csv",
  "CABusinessRules05052026.csv",
  "CARates05052026.csv",
  "CABenefits05052026.csv",
];

beforeAll(async () => {
  process.env.OPENPLANS_COMPAT_API_KEY = token;
  directory = await mkdtemp(join(tmpdir(), "openplans-ca-tobacco-"));
  migration = await coreMigrations();
  await migrate(db, migration.directory);
  manifest = JSON.parse(await readFile(join(root, "provenance.json"), "utf8"));
  const files: ImportFile[] = await Promise.all(
    IMPORT_KINDS.map(async (kind, at) => {
      const member = names[at]!,
        path = join(root, member),
        bytes = await readFile(path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect(sha256).toBe(
        manifest.files.find((f) => f.member === member)!.cutSha256,
      );
      return {
        kind,
        path,
        member,
        format: "csv",
        source: "cms_sbe_puf",
        url: manifest.url,
        sha256,
        bytes: bytes.length,
        retrievedAt: "2026-11-09T00:00:00Z",
      };
    }),
  );
  const imported = await importSbe(db, {
    state: "CA",
    year: 2026,
    dataDir: directory,
    files,
  });
  expect(imported.status, JSON.stringify(imported)).toBe("ACTIVE");
  rateSnapshot = (
    await db.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM puf_import_file WHERE import_id=$1 AND kind='rate'",
      [imported.import_id],
    )
  ).rows[0]!.snapshot_id;
  const geoRoot = fileURLToPath(
    new URL("../fixtures/sbe/geography/", import.meta.url),
  );
  const geo = JSON.parse(
    await readFile(join(geoRoot, "provenance.json"), "utf8"),
  ) as {
    states: {
      CA: Record<
        string,
        {
          file: string;
          original: GeoFiles["relationship"]["metadata"];
          sha256: string;
          bytes: number;
        }
      >;
    };
  };
  // Acquisition wrappers describe the unmodified public cuts, not a full download.
  const geography = Object.fromEntries(
    Object.entries(geo.states.CA).map(([kind, f]) => [
      kind,
      {
        path: join(geoRoot, f.file),
        zipped: false,
        metadata: { ...f.original, sha256: f.sha256, bytes: f.bytes },
      },
    ]),
  ) as GeoFiles;
  await ingestSbeGeography(db, {
    state: "CA",
    planYear: 2026,
    files: geography,
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.OPENPLANS_COMPAT_API_KEY;
  await db.close();
  await migration?.cleanup();
  await rm(directory, { recursive: true, force: true });
});

type Example = (typeof caExamples)[number];
interface MemberInput {
  age: number;
  relationship: string;
  tobacco: boolean;
}
interface NativeEstimate {
  status: string;
  total_cents?: number;
  members: {
    age: number;
    tobacco: boolean;
    premium_cents: number | null;
    charged: boolean;
  }[];
  provenance: {
    rating_rule: { method: string; citation: string; snapshot_id: string };
    tobacco_policy?: typeof medicalPolicy.CA_INDIVIDUAL_TOBACCO_POLICY;
  };
  rate_rows_used: { provenance: { snapshot_id: string; source_row: number } }[];
}
interface CompatQuote {
  premium: number | null;
  premiums_by_applicant: {
    smoker: boolean;
    premium: number | null;
    waived_for_total: boolean;
  }[];
}
async function quote(
  tx: SqlSession,
  example: Example,
  tobacco: boolean,
  coverage = "2026-01-01",
  members: MemberInput[] = [{ age: 40, relationship: "subscriber", tobacco }],
) {
  const response = await createApp(tx, { premiumToken: token }).request(
    "/v1/premium-quotes",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        plan_ids: [example.plan],
        county: example.county,
        ...(example.area === "Rating Area 16" ? { zip: example.zip } : {}),
        coverage_start: coverage,
        members,
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { quotes: NativeEstimate[] };
  return body.quotes[0]!;
}
async function compat(
  tx: SqlSession,
  example: Example,
  tobacco: boolean,
  coverage = "2026-01-01",
  members: MemberInput[] = [{ age: 40, relationship: "subscriber", tobacco }],
) {
  const response = await createApp(tx, { premiumToken: token }).request(
    "/compat/v1/plans/medical/search",
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": token },
      body: JSON.stringify({
        fips_code: example.county,
        ...(example.area === "Rating Area 16" ? { zip_code: example.zip } : {}),
        ids: [example.plan],
        enrollment_date: coverage,
        applicants: members.map((member) => ({
          age: member.age,
          smoker: member.tobacco,
          child: member.relationship === "child",
        })),
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { plans: CompatQuote[] };
  return body.plans[0]!;
}
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic CA mutation rollback");
  await expect(
    db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
function assertFiled(estimate: NativeEstimate, cents: number) {
  assert.equal(estimate.status, "rated", "filed gross status");
  assert.equal(estimate.total_cents, cents, "filed gross cents");
}

it.each(caExamples)(
  "native and compatibility endpoints preserve filed gross and tobacco in $area",
  async (example) => {
    for (const coverage of ["2026-01-01", "2026-12-31"]) {
      for (const tobacco of [false, true]) {
        const native = await quote(db, example, tobacco, coverage);
        assertFiled(native, example.cents);
        expect(native.members).toMatchObject([
          { tobacco, premium_cents: example.cents, charged: true },
        ]);
        expect(native.provenance.rating_rule).toMatchObject({
          method: "per_member",
          citation:
            medicalPolicy.CA_INDIVIDUAL_TOBACCO_POLICY.provenance.citation,
          snapshot_id: expect.any(String),
        });
        expect(native.provenance.tobacco_policy).toEqual(
          medicalPolicy.CA_INDIVIDUAL_TOBACCO_POLICY,
        );
        const row = native.rate_rows_used[0]!.provenance;
        expect(row.snapshot_id).toBe(rateSnapshot);
        const source = manifest.files.find(
          (f) => f.member === "CARates05052026.csv",
        )!;
        expect(source.sourceRows[row.source_row - 2]).toBe(example.row);
        expect(await compat(db, example, tobacco, coverage)).toMatchObject({
          premium: example.cents / 100,
          premiums_by_applicant: [
            {
              smoker: tobacco,
              premium: example.cents / 100,
              waived_for_total: false,
            },
          ],
        });
      }
    }
  },
);

it("keeps filed family gross and the uncharged fourth child through both endpoints", async () => {
  const example = { ...caExamples[2]!, plan: "70285CA1250001" };
  const members = [
    { age: 35, relationship: "subscriber", tobacco: true },
    { age: 33, relationship: "spouse", tobacco: false },
    { age: 5, relationship: "child", tobacco: true },
  ];
  const native = await quote(db, example, true, undefined, members);
  assertFiled(native, 449675);
  expect(native.members.map((m) => m.premium_cents)).toEqual([
    172528, 169140, 108007,
  ]);
  expect(await compat(db, example, true, undefined, members)).toMatchObject({
    premium: 4496.75,
    premiums_by_applicant: [
      { smoker: true, premium: 1725.28 },
      { smoker: false, premium: 1691.4 },
      { smoker: true, premium: 1080.07 },
    ],
  });
  const fourChildren = [
    ...members.slice(0, 2),
    ...[8, 7, 5, 4].map((age) => ({
      age,
      relationship: "child",
      tobacco: true,
    })),
  ];
  const four = await quote(db, example, true, undefined, fourChildren);
  assertFiled(four, 665689);
  expect(four.members[5]).toMatchObject({
    charged: false,
    premium_cents: 0,
    tobacco: true,
  });
  expect(
    (await compat(db, example, true, undefined, fourChildren))
      .premiums_by_applicant[5],
  ).toMatchObject({ smoker: true, premium: 0, waived_for_total: true });
});

it("negative control: removing CA authorization restores the null and fails the filed-gross assertion", async () => {
  const disabled = vi
    .spyOn(medicalPolicy, "medicalTobaccoPolicy")
    .mockReturnValue(null);
  try {
    const estimate = await quote(db, caExamples[0]!, true);
    expect(estimate).toMatchObject({
      status: "unknown",
      members: [{ tobacco: true, premium_cents: null }],
    });
    expect(estimate).not.toHaveProperty("total_cents");
    expect(estimate.provenance).not.toHaveProperty("tobacco_policy");
    expect(() => assertFiled(estimate, caExamples[0]!.cents)).toThrow(
      "filed gross status",
    );
    expect(await compat(db, caExamples[0]!, true)).toMatchObject({
      premium: null,
      premiums_by_applicant: [{ smoker: true, premium: null }],
    });
  } finally {
    disabled.mockRestore();
  }
});

it("expired intervals and missing or ambiguous rows never yield a price", async () => {
  for (const mutation of [
    "UPDATE rate SET expiration_date='2026-12-30'",
    "DELETE FROM rate",
    "INSERT INTO rate SELECT snapshot_id,source_row+1000000,plan_year,state,issuer_id,base_plan_id,rating_area_id,effective_date,expiration_date,tobacco,age_band,rating_method,individual_rate_cents,individual_tobacco_rate_cents,couple_cents,primary_subscriber_and_one_dependent_cents,primary_subscriber_and_two_dependents_cents,primary_subscriber_and_three_or_more_dependents_cents,couple_and_one_dependent_cents,couple_and_two_dependents_cents,couple_and_three_or_more_dependents_cents,raw FROM rate",
  ]) {
    await rollback(async (tx) => {
      await tx.exec(mutation);
      const estimate = await quote(tx, caExamples[0]!, true, "2026-12-31");
      expect(estimate.status).toBe(
        mutation.startsWith("INSERT") ? "ambiguous" : "missing",
      );
      expect(estimate).not.toHaveProperty("total_cents");
      expect(() => assertFiled(estimate, caExamples[0]!.cents)).toThrow(
        "filed gross status",
      );
      expect(
        (await compat(tx, caExamples[0]!, true, "2026-12-31")).premium,
      ).toBeNull();
    });
  }
});
