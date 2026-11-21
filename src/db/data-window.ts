import type { Database, SqlSession } from "./database.js";
import { admissionSchema } from "../domain/data-window.js";
import type { AnnualAdmission, LoadedYears } from "../domain/data-window.js";

/** Admission is an explicit publication record, independent of downloaded or imported rows. */
export async function annualAdmissions(db: SqlSession) {
  const { rows } = await db.query(
    `SELECT domain, coverage_year, manifest FROM annual_data_admission ORDER BY domain, coverage_year`,
  );
  const admissions = rows.map((row) => admissionSchema.parse(row));
  await validateAnnualAdmissions(db, admissions);
  return admissions;
}

async function validateAnnualAdmissions(
  db: SqlSession,
  admissions: readonly AnnualAdmission[],
) {
  const releases = admissions.flatMap((row) => row.manifest.releases);
  if (!releases.length) return;
  const result = await db.query(
    `SELECT r.snapshot_id FROM jsonb_to_recordset($1::jsonb)
      AS r(snapshot_id text, kind text, contract_year integer, family text)
    WHERE NOT EXISTS (
      SELECT 1 FROM snapshot s WHERE s.snapshot_id=r.snapshot_id AND s.validation_state='ACTIVE'
        AND CASE r.kind
          WHEN 'puf' THEN EXISTS (SELECT 1 FROM puf_import i JOIN puf_active_catalog a USING(import_id)
            WHERE i.import_id=s.snapshot_id AND i.plan_year=r.contract_year AND a.plan_year=r.contract_year
            AND EXISTS (SELECT 1 FROM puf_import_file f WHERE f.import_id=i.import_id)
            AND NOT EXISTS (SELECT 1 FROM puf_import_file f JOIN snapshot d ON d.snapshot_id=f.snapshot_id
              WHERE f.import_id=i.import_id AND d.validation_state<>'ACTIVE'))
          WHEN 'state' THEN EXISTS (SELECT 1 FROM state_rate_import i JOIN state_rate_active a USING(import_id)
            WHERE i.import_id=s.snapshot_id AND i.plan_year=r.contract_year AND a.plan_year=r.contract_year)
          WHEN 'medicare' THEN EXISTS (SELECT 1 FROM medicare_release m WHERE m.snapshot_id=s.snapshot_id
            AND m.contract_year=r.contract_year AND m.family=COALESCE(r.family,'landscape'))
          WHEN 'partd' THEN EXISTS (SELECT 1 FROM partd_release d WHERE d.snapshot_id=s.snapshot_id AND d.contract_year=r.contract_year)
          ELSE false END)
    LIMIT 1`,
    [JSON.stringify(releases)],
  );
  if (result.rows.length)
    throw new Error("annual_admission_dependency_invalid");
}

/** Explicit operator publication; imported rows never call this function. */
export async function admitAnnualData(db: Database, input: readonly unknown[]) {
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return publishAnnualData(tx, input);
  });
}

/** The caller owns the transaction, including selection of reviewed release receipts. */
export async function publishAnnualData(
  tx: SqlSession,
  input: readonly unknown[],
) {
  const admissions = input.map((row) => admissionSchema.parse(row));
  if (
    new Set(admissions.map((row) => `${row.domain}:${row.coverage_year}`))
      .size !== admissions.length
  )
    throw new Error("annual_admission_duplicate");
  await validateAnnualAdmissions(tx, admissions);
  for (const row of admissions) {
    const existing = await tx.query(
      "SELECT domain FROM annual_data_admission WHERE domain=$1 AND coverage_year=$2 AND manifest=$3::jsonb",
      [row.domain, row.coverage_year, row.manifest],
    );
    if (existing.rows.length) continue;
    await tx.query(
      `INSERT INTO annual_data_admission(domain,coverage_year,manifest) VALUES ($1,$2,$3)
      ON CONFLICT (domain,coverage_year) DO UPDATE SET manifest=excluded.manifest
      WHERE annual_data_admission.manifest IS DISTINCT FROM excluded.manifest`,
      [row.domain, row.coverage_year, row.manifest],
    );
  }
  return admissions;
}

/** These are published-year inventories, not a claim that every state or source is complete. */
export async function annualLoadedYears(db: SqlSession): Promise<LoadedYears> {
  const { rows } = await db.query<{
    domain: "individual" | "medicare";
    year: number;
  }>(`
    SELECT 'individual' AS domain,a.plan_year AS year FROM puf_active_catalog a
      JOIN puf_import i USING(import_id) JOIN snapshot s ON s.snapshot_id=i.import_id
      WHERE s.validation_state='ACTIVE' AND i.plan_year=a.plan_year
    UNION SELECT 'individual',a.plan_year FROM state_rate_active a
      JOIN snapshot s ON s.snapshot_id=a.import_id WHERE s.validation_state='ACTIVE'
    UNION SELECT 'individual',a.plan_year FROM provider_active_set a
      JOIN snapshot s USING(snapshot_id) WHERE s.validation_state='ACTIVE'
    UNION SELECT 'individual',a.plan_year FROM formulary_active_set a
      JOIN snapshot s USING(snapshot_id) WHERE s.validation_state='ACTIVE'
    UNION SELECT 'medicare',r.contract_year FROM medicare_release r JOIN snapshot s USING(snapshot_id)
      WHERE s.validation_state='ACTIVE'
    UNION SELECT 'medicare',r.contract_year FROM partd_release r JOIN snapshot s USING(snapshot_id)
      WHERE s.validation_state='ACTIVE' ORDER BY domain,year`);
  return {
    individual: rows
      .filter((row) => row.domain === "individual")
      .map((row) => Number(row.year)),
    medicare: rows
      .filter((row) => row.domain === "medicare")
      .map((row) => Number(row.year)),
  };
}
