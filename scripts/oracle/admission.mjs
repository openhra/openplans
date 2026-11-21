/**
 * Next-year admission for the isolated oracle databases.
 *
 * The API serves next year's plans only after an operator publishes an annual admission. Release
 * tooling publishes one per domain from the ACTIVE catalogs it loaded, and so does this helper,
 * from the catalogs an oracle imported from its hash-checked cache. It writes through
 * admitAnnualData, the same function `worker data-admission --manifest` calls, so the product
 * still validates every release receipt. Prior and current years are served without an
 * admission, and nothing is written for them.
 */
import { admitAnnualData } from "../../dist/db/data-window.js";

/** Same selection as a release: each ACTIVE federal catalog of that year. */
async function individualReleases(db, year) {
  const { rows } = await db.query(
    `SELECT a.import_id FROM puf_active_catalog a WHERE a.plan_year=$1 ORDER BY a.state`,
    [year],
  );
  return rows.map((row) => ({
    kind: "puf",
    snapshot_id: row.import_id,
    contract_year: year,
  }));
}

/** Same selection as a release: the ACTIVE Medicare catalogs and Part D files of that year. */
async function medicareReleases(db, year) {
  const { rows } = await db.query(
    `SELECT 'medicare' AS kind, r.family, r.snapshot_id FROM medicare_release r
      JOIN snapshot s USING(snapshot_id) WHERE r.contract_year=$1 AND s.validation_state='ACTIVE'
    UNION ALL SELECT 'partd', NULL, r.snapshot_id FROM partd_release r
      JOIN snapshot s USING(snapshot_id) WHERE r.contract_year=$1 AND s.validation_state='ACTIVE'
    ORDER BY kind, family, snapshot_id`,
    [year],
  );
  return rows.map(({ kind, family, snapshot_id }) => ({
    kind,
    snapshot_id,
    contract_year: year,
    ...(kind === "medicare" ? { family } : {}),
  }));
}

/**
 * Admits `year` for `domain` when it is next year. Returns the admissions written, or [] when the
 * year needs none. Throws when there is nothing ACTIVE to admit or a receipt fails validation.
 */
export async function admitNextYear(db, domain, year, now = new Date()) {
  if (year <= now.getUTCFullYear()) return [];
  const select = { individual: individualReleases, medicare: medicareReleases }[
    domain
  ];
  if (!select) throw new Error(`Unknown annual domain ${domain}`);
  const releases = await select(db, year);
  if (!releases.length)
    throw new Error(`No ACTIVE ${domain} release to admit for ${year}`);
  return admitAnnualData(db, [
    {
      domain,
      coverage_year: year,
      manifest: { schema_version: 1, releases },
    },
  ]);
}
