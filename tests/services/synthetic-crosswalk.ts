import { expect } from "vitest";
import type { SqlSession } from "../../src/db/database.js";

// The fixture serves no plan ID crosswalk. Tests that need one add these SYNTHETIC rows inside a
// transaction that always rolls back.

/** A made-up 2025 plan that every 2026 plan absorbs. */
const SHARED_PRIOR = "99999TX0000001";

/**
 * A SYNTHETIC plan ID crosswalk served for 2026 and 2025. Every 2026 plan in the catalog renews
 * itself and absorbs two made-up 2025 plans: one of its own and SHARED_PRIOR. Its 2025 version
 * renews itself from 2024. Each plan ends up with four prior-year IDs over two crosswalk years.
 */
export async function withCrosswalk(tx: SqlSession) {
  const { rows } = await tx.query("SELECT 1 FROM plan_lineage_active");
  expect(rows, "the fixture serves no crosswalk of its own").toEqual([]);
  for (const year of [2026, 2025]) {
    const snapshot = `synthetic-crosswalk-${year}`;
    await tx.query(
      `INSERT INTO snapshot (snapshot_id, source_id)
        SELECT $1, source_id FROM snapshot ORDER BY snapshot_id LIMIT 1`,
      [snapshot],
    );
    // 2026 plans name a renewal and two merged 2025 plans; 2025 names only the renewal.
    const priors =
      year === 2026
        ? `ARRAY[p.base_plan_id, left(p.base_plan_id,7) || '7' || substr(p.base_plan_id,9), '${SHARED_PRIOR}']`
        : "ARRAY[p.base_plan_id]";
    await tx.query(
      `INSERT INTO plan_lineage (snapshot_id, source_row, state, dental_only, prior_year,
        prior_plan_id, prior_issuer_id, plan_year, plan_id, issuer_id, county_fips, zip_code,
        crosswalk_level, crosswalk_reason, raw)
      SELECT $1, (row_number() OVER (ORDER BY p.base_plan_id, prior))::integer, p.state,
        p.dental_only, $2::integer - 1, prior, left(prior,5), $2, p.base_plan_id,
        left(p.base_plan_id,5), '48201', '77002', 'synthetic', 'synthetic',
        jsonb_build_object('synthetic', true)
      FROM plan p CROSS JOIN unnest(${priors}) prior
      WHERE p.plan_year=2026 AND p.state='TX'`,
      [snapshot, year],
    );
    await tx.query(
      "INSERT INTO plan_lineage_active (plan_year, snapshot_id) VALUES ($1, $2)",
      [year, snapshot],
    );
  }
}
