import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { dentalHouseholdOffering } from "../../../src/compat/v1/dental.js";
import type { SqlSession } from "../../../src/db/database.js";
import type { HouseholdMember } from "../../../src/domain/rating/types.js";

const fixture = JSON.parse(
  await readFile(
    new URL("./dental-offering-public.json", import.meta.url),
    "utf8",
  ),
) as {
  sha256: string;
  rows: { source_row: number; values: Record<string, string> }[];
};
const adults: HouseholdMember[] = [
  { id: "0", age: 35, relationship: "subscriber", tobaccoUse: false },
];
const mixed: HouseholdMember[] = [
  ...adults,
  { id: "1", age: 10, relationship: "child", tobaccoUse: false },
];
const snapshot = "synthetic-envelope-for-public-offering-cut";
function sourceRows(rows: typeof fixture.rows): SqlSession {
  return {
    async query<Row extends Record<string, unknown>>(
      _sql: string,
      parameters?: unknown[],
    ) {
      assert.equal(parameters?.[0], snapshot);
      return {
        rows: rows
          .filter((row) => row.values.StandardComponentId === parameters?.[1])
          .map((row) => ({
            raw: row.values,
            source_row: row.source_row,
          })) as unknown as Row[],
      };
    },
    async exec() {
      throw new Error("Read-only offering test");
    },
  };
}
it("filters all ten public child-only SADPs for adults and retains them for mixed households with row provenance", async () => {
  const ids = [
    ...new Set(fixture.rows.map((row) => row.values.StandardComponentId!)),
  ];
  expect(ids).toHaveLength(10);
  let excluded = 0;
  for (const id of ids) {
    const plan = { snapshot_id: snapshot, base_plan_id: id };
    const adult = await dentalHouseholdOffering(
      sourceRows(fixture.rows),
      plan,
      adults,
      "2026-01-01",
    );
    expect(adult.offered).toBe(false);
    excluded += Number(!adult.offered);
    expect(adult.provenance).toEqual(
      fixture.rows
        .filter((row) => row.values.StandardComponentId === id)
        .map((row) => ({
          snapshot_id: snapshot,
          source_row: row.source_row,
          child_only_offering: row.values.ChildOnlyOffering,
        })),
    );
    expect(
      (
        await dentalHouseholdOffering(
          sourceRows(fixture.rows),
          plan,
          mixed,
          "2026-01-01",
        )
      ).offered,
    ).toBe(true);
  }
  expect(excluded).toBe(10);
});
it("keeps missing, blank, unknown and conflicting public offering evidence", async () => {
  const original = fixture.rows[0]!;
  const plan = {
    snapshot_id: snapshot,
    base_plan_id: original.values.StandardComponentId!,
  };
  for (const value of [
    undefined,
    "",
    "unknown",
    "Allows Adult and Child-Only",
  ]) {
    const row = structuredClone(original);
    if (value === undefined) delete row.values.ChildOnlyOffering;
    else row.values.ChildOnlyOffering = value;
    expect(
      (
        await dentalHouseholdOffering(
          sourceRows([row]),
          plan,
          adults,
          "2026-01-01",
        )
      ).offered,
    ).toBe(true);
    expect(
      (
        await dentalHouseholdOffering(
          sourceRows([original, row]),
          plan,
          adults,
          "2026-01-01",
        )
      ).offered,
    ).toBe(true);
  }
  expect(
    (await dentalHouseholdOffering(sourceRows([]), plan, adults, "2026-01-01"))
      .offered,
  ).toBe(true);
  expect(
    (
      await dentalHouseholdOffering(
        sourceRows(fixture.rows),
        plan,
        [
          {
            id: "0",
            dateOfBirth: "2006-01-02",
            relationship: "subscriber",
            tobaccoUse: false,
          },
        ],
        "2026-01-01",
      )
    ).offered,
  ).toBe(true);
});
