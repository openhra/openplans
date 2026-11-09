import { afterAll, beforeAll, expect, it } from "vitest";
import { writeFile, rename } from "node:fs/promises";
import {
  locationZipCounties,
  resolveLocation,
} from "../../src/api/repository.js";
import { geoSetup } from "./geo-helpers.js";

let h: Awaited<ReturnType<typeof geoSetup>>;
beforeAll(async () => {
  h = await geoSetup();
});
afterAll(async () => {
  await h?.close();
});

it("resolves both published counties from the retained national source when SQL is state-scoped", async () => {
  for (const county of ["12069", "12095"]) {
    const result = await resolveLocation(h.db, { zip: "34787", county });
    expect(result).toMatchObject({ status: "available", zip: "34787", county });
    expect(result.counties.map((row) => row.county_fips)).toEqual([
      "12069",
      "12095",
    ]);
    expect(result.counties[0]).toMatchObject({
      county_name: "Lake County",
      source: "zcta",
      snapshot_id: h.snapshot,
      source_row: 3,
    });
  }
});

it("keeps a multi-county ZIP ambiguous without an explicit county", async () => {
  expect(await resolveLocation(h.db, { zip: "34787" })).toMatchObject({
    status: "ambiguous",
  });
  expect(await resolveLocation(h.db, { zip: "34786" })).toMatchObject({
    status: "available",
    county: "12095",
  });
});

it("negative controls: rejects fake counties and a real county outside a single-county ZIP", async () => {
  for (const input of [
    { zip: "34787", county: "12999" },
    { zip: "34786", county: "12069" },
    { zip: "77002", county: "12069" },
  ]) {
    await expect(resolveLocation(h.db, input)).rejects.toMatchObject({
      code: "ZIP_COUNTY_MISMATCH",
      field: "county",
    });
  }
  expect(
    await resolveLocation(h.db, { zip: "00000", county: "12069" }),
  ).toMatchObject({ status: "unknown", counties: [] });
});

it("negative control: a removed intersection cannot be accepted from the other county", async () => {
  const marker = new Error("synthetic geography rollback");
  const mutant = Buffer.from(
    h.bytes
      .toString("utf8")
      .split("\n")
      .filter((line) => !line.includes("|12069|"))
      .join("\n"),
  );
  const { createHash } = await import("node:crypto");
  try {
    await writeFile(h.path, mutant);
    await expect(
      h.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE snapshot SET sha256=$1,compressed_bytes=$2 WHERE snapshot_id=$3",
          [
            createHash("sha256").update(mutant).digest("hex"),
            mutant.length,
            h.snapshot,
          ],
        );
        await expect(
          resolveLocation(tx, { zip: "34787", county: "12069" }),
        ).rejects.toMatchObject({ code: "ZIP_COUNTY_MISMATCH" });
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    await writeFile(h.path, h.bytes);
  }
});

it("negative control: tampered source bytes fail hash verification even after a cached lookup", async () => {
  await locationZipCounties(h.db, "34787");
  const mutant = Buffer.from(
    h.bytes.toString("utf8").replace("|12095|", "|12999|"),
  );
  try {
    await writeFile(h.path, mutant);
    await expect(locationZipCounties(h.db, "34787")).rejects.toThrow(
      "hash mismatch",
    );
  } finally {
    await writeFile(h.path, h.bytes);
  }
});

it("does not require a raw-cache mount or invent an intersection when the snapshot is absent", async () => {
  await rename(h.path, h.path + ".held");
  try {
    expect(await locationZipCounties(h.db, "34787")).toMatchObject({
      source: "geonames",
      counties: [{ county_fips: "12095" }],
    });
    await expect(
      resolveLocation(h.db, { zip: "34787", county: "12069" }),
    ).rejects.toMatchObject({ code: "ZIP_COUNTY_MISMATCH" });
  } finally {
    await rename(h.path + ".held", h.path);
  }
});
