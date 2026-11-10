import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Database, SqlSession } from "../../db/database.js";
import type { AcquiredRelease } from "./acquire.js";
import { filesPage, sourceId } from "./acquire.js";
import { archiveInput } from "./input.js";
import type { Input } from "./input.js";
import {
  date,
  flag,
  mainAddress,
  mainRequired,
  nullable,
  rows,
  secondaryAddress,
  secondaryRequired,
  validNpi,
} from "./parse.js";

export interface ImportOptions extends AcquiredRelease {
  state: string;
  /** Trusted offline test adapter only. Production reads the hash-verified archive. */
  fixture?: { input: Input; dataDate: string };
  progress?: (message: string) => void;
}
export interface ImportReport {
  snapshot_id: string;
  kind: string;
  state: string;
  data_date: string;
  outcome: "imported" | "noop" | "superseded";
  read: number;
  kept: number;
  skipped: number;
  invalid: number;
  providers: number;
  taxonomies: number;
  addresses: number;
  deactivated: number;
  elapsed_ms: number;
}
const providerColumns = [
  "entity_type",
  "first_name",
  "middle_name",
  "last_name",
  "name_prefix",
  "name_suffix",
  "credential",
  "organization_name",
  "enumeration_date",
  "last_update_date",
  "deactivation_date",
  "reactivation_date",
  "deactivated",
  "sole_proprietor",
  "data_date",
  "snapshot_id",
  "status_snapshot_id",
];
const addressColumns = [
  "npi",
  "kind",
  "ordinal",
  "line_1",
  "line_2",
  "city",
  "state",
  "postal_code",
  "country",
  "zip5",
  "zip4",
  "phone",
  "phone_extension",
  "snapshot_id",
];
const taxonomyColumns = [
  "npi",
  "ordinal",
  "code",
  "is_primary",
  "license_state",
  "snapshot_id",
];
type RecordValue = Record<string, unknown>;
async function insertRecords(
  tx: SqlSession,
  table: string,
  columns: string[],
  records: RecordValue[],
) {
  if (!records.length) return;
  await tx.query(
    `INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.join(",")} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
    [JSON.stringify(records)],
  );
}
async function tableCounts(tx: SqlSession) {
  return (
    await tx.query<{
      providers: number;
      taxonomies: number;
      addresses: number;
      deactivated: number;
    }>(`SELECT
    (SELECT count(*)::int FROM npi_provider) providers,(SELECT count(*)::int FROM npi_taxonomy) taxonomies,
    (SELECT count(*)::int FROM npi_address) addresses,(SELECT count(*)::int FROM npi_provider WHERE deactivated) deactivated`)
  ).rows[0]!;
}
async function issue(
  tx: SqlSession,
  snapshot: string,
  record: number,
  member: string,
) {
  await tx.query(
    `INSERT INTO quality_issue(source_id,snapshot_id,source_record,severity,issue_code,explanation)
    VALUES($1,$2,$3,'error','invalid_npi_checksum','NPI fails the 80840-prefixed Luhn check; row skipped')`,
    [sourceId, snapshot, `${member}:${record}`],
  );
}

/** Current, last-observed identities. Monthly and weekly changes are atomic; deactivation never deletes. */
export async function importNppes(
  db: Database,
  options: ImportOptions,
): Promise<ImportReport> {
  const started = Date.now(),
    { metadata, kind, state } = options;
  if (
    !/^[A-Z]{2}$/.test(state) ||
    metadata.source !== sourceId ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
    !/^https:\/\/download\.cms\.gov\/nppes\/[^?#]+_V2\.zip$/i.test(
      options.url,
    ) ||
    metadata.url !== options.url
  )
    throw new Error(
      "Wrong NPPES version/provenance: official V2 source required",
    );
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(options.path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (hash.digest("hex") !== metadata.sha256 || bytes !== metadata.bytes)
    throw new Error("NPPES cache integrity mismatch");
  const snapshot = `nppes-${kind}-${state}-${metadata.sha256}`;
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence,terms_review_reference)
    VALUES($1,'Centers for Medicare & Medicaid Services','nppes',$2::jsonb,$3) ON CONFLICT DO NOTHING`,
    [
      sourceId,
      JSON.stringify([
        {
          url: filesPage,
          role: "public identity, taxonomy and locations; no participation evidence",
        },
      ]),
      filesPage,
    ],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,
    http_status,etag,last_modified,content_type,compressed_bytes,sha256,raw_path,schema_version,parser_version,expected_children)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,'nppes-v2','1',$14) ON CONFLICT DO NOTHING`,
    [
      snapshot,
      sourceId,
      metadata.url,
      metadata.final_url,
      JSON.stringify(metadata.redirect_chain),
      metadata.fetched_at,
      metadata.status,
      metadata.etag,
      metadata.last_modified,
      metadata.content_type,
      bytes,
      metadata.sha256,
      options.path,
      kind === "deactivation" ? 1 : 2,
    ],
  );
  try {
    return await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(1869636978)");
      const existing = (
        await tx.query<{ report: ImportReport }>(
          "SELECT report FROM npi_import_run WHERE snapshot_id=$1",
          [snapshot],
        )
      ).rows[0];
      if (existing)
        return {
          ...existing.report,
          outcome: "noop",
          elapsed_ms: Date.now() - started,
        };
      const { input, dataDate } =
        options.fixture ?? (await archiveInput(options.path, kind));
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(dataDate) ||
        Number.isNaN(Date.parse(dataDate)) ||
        new Date(dataDate).toISOString().slice(0, 10) !== dataDate
      )
        throw new Error("Invalid NPPES bundle date");
      const report: ImportReport = {
        snapshot_id: snapshot,
        kind,
        state,
        data_date: dataDate,
        outcome: "imported",
        read: 0,
        kept: 0,
        skipped: 0,
        invalid: 0,
        providers: 0,
        taxonomies: 0,
        addresses: 0,
        deactivated: 0,
        elapsed_ms: 0,
      };
      if (kind === "weekly") {
        const baseline = (
          await tx.query<{ data_date: string }>(
            "SELECT data_date::text FROM npi_import_run WHERE kind='full' AND state_filter=$1 ORDER BY data_date DESC LIMIT 1",
            [state],
          )
        ).rows[0];
        if (baseline && dataDate < baseline.data_date) {
          // A weekly file from before the monthly cutoff cannot resurrect an out-of-state NPI.
          Object.assign(report, await tableCounts(tx), {
            outcome: "superseded",
            elapsed_ms: Date.now() - started,
          });
          await tx.query(
            "UPDATE snapshot SET validation_state='RECONCILED',publisher_updated_at=$2 WHERE snapshot_id=$1",
            [snapshot, dataDate],
          );
          return report;
        }
      }
      if ("deactivations" in input) {
        if (kind !== "deactivation") throw new Error("Mismatched NPPES input");
        let batch: RecordValue[] = [];
        const flush = async () => {
          if (!batch.length) return;
          await tx.query(
            `INSERT INTO npi_deactivation SELECT * FROM jsonb_populate_recordset(NULL::npi_deactivation,$1::jsonb)
            ON CONFLICT(npi) DO UPDATE SET deactivation_date=excluded.deactivation_date,snapshot_id=excluded.snapshot_id
            WHERE excluded.deactivation_date>npi_deactivation.deactivation_date`,
            [JSON.stringify(batch)],
          );
          batch = [];
        };
        for await (const row of input.deactivations()) {
          report.read++;
          if (!validNpi(row[0] ?? "")) {
            report.invalid++;
            report.skipped++;
            await issue(tx, snapshot, report.read, "deactivation");
            continue;
          }
          const d = date(row[1] ?? "");
          if (!d) throw new Error("Missing deactivation date");
          batch.push({
            npi: row[0],
            deactivation_date: d,
            snapshot_id: snapshot,
          });
          report.kept++;
          if (batch.length >= 500) await flush();
        }
        await flush();
      } else {
        if (kind === "deactivation") throw new Error("Mismatched NPPES input");
        await tx.exec(
          "CREATE TEMP TABLE npi_secondary(npi text NOT NULL, address jsonb NOT NULL) ON COMMIT DROP",
        );
        let secondaryBatch: RecordValue[] = [];
        const flushSecondary = async () => {
          if (secondaryBatch.length)
            await tx.query(
              `INSERT INTO npi_secondary SELECT npi,address FROM jsonb_to_recordset($1::jsonb) AS x(npi text,address jsonb)`,
              [JSON.stringify(secondaryBatch)],
            );
          secondaryBatch = [];
        };
        for await (const { get, rowNumber } of rows(
          input.secondary(),
          secondaryRequired,
        )) {
          if (!validNpi(get("NPI"))) {
            report.invalid++;
            await issue(tx, snapshot, rowNumber, "secondary");
            continue;
          }
          secondaryBatch.push({
            npi: get("NPI"),
            address: secondaryAddress(get, rowNumber),
          });
          if (secondaryBatch.length >= 500) await flushSecondary();
        }
        await flushSecondary();
        await tx.exec("CREATE INDEX ON npi_secondary(npi)");
        // Only the state's secondary-location membership set is held in memory; addresses remain in SQL.
        const txSecondary = new Set(
          (
            await tx.query<{ npi: string }>(
              "SELECT DISTINCT npi FROM npi_secondary WHERE address->>'state'=$1",
              [state],
            )
          ).rows.map((r) => r.npi),
        );
        const known = new Set(
          (
            await tx.query<{ npi: string }>(
              "SELECT npi FROM npi_state_scope WHERE state_filter=$1",
              [state],
            )
          ).rows.map((r) => r.npi),
        );
        let batch: RecordValue[] = [];
        const flush = async () => {
          if (!batch.length) return;
          const inserted = await tx.query<{ npi: string }>(
            `INSERT INTO npi_provider SELECT p.* FROM jsonb_populate_recordset(NULL::npi_provider,$1::jsonb) p
            ON CONFLICT(npi) DO UPDATE SET ${providerColumns.map((c) => `${c}=excluded.${c}`).join(",")}
            WHERE excluded.data_date>npi_provider.data_date RETURNING npi`,
            [JSON.stringify(batch)],
          );
          const changed = new Set(inserted.rows.map((r) => r.npi)),
            selected = batch.filter((r) => changed.has(r.npi as string));
          const ids = [...changed];
          if (ids.length) {
            await tx.query(
              "DELETE FROM npi_address WHERE npi=ANY($1::text[])",
              [ids],
            );
            await tx.query(
              "DELETE FROM npi_taxonomy WHERE npi=ANY($1::text[])",
              [ids],
            );
            await insertRecords(
              tx,
              "npi_address",
              addressColumns,
              selected.flatMap((r) => r.addresses as RecordValue[]),
            );
            await insertRecords(
              tx,
              "npi_taxonomy",
              taxonomyColumns,
              selected.flatMap((r) => r.taxonomies as RecordValue[]),
            );
            await tx.query(
              `INSERT INTO npi_address(${addressColumns.join(",")}) SELECT ${addressColumns.map((c) => `a.${c}`).join(",")} FROM npi_secondary s,
              LATERAL jsonb_populate_record(NULL::npi_address,s.address || jsonb_build_object('npi',s.npi,'snapshot_id',$2::text)) a
              WHERE s.npi=ANY($1::text[])`,
              [ids, snapshot],
            );
          }
          // Even when an identical national release already supplied the shared identity,
          // each state's selection and provenance are recorded independently.
          await tx.query(
            `INSERT INTO npi_state_scope(npi,state_filter,in_scope,data_date,snapshot_id)
            SELECT npi,state_filter,in_scope,data_date,snapshot_id
            FROM jsonb_populate_recordset(NULL::npi_state_scope,$1::jsonb)
            ON CONFLICT(npi,state_filter) DO UPDATE SET in_scope=excluded.in_scope,
              data_date=excluded.data_date,snapshot_id=excluded.snapshot_id
            WHERE excluded.data_date>=npi_state_scope.data_date`,
            [
              JSON.stringify(
                batch.map((r) => ({
                  npi: r.npi,
                  state_filter: state,
                  in_scope: r.in_scope,
                  data_date: dataDate,
                  snapshot_id: snapshot,
                })),
              ),
            ],
          );
          // Compatibility field: in scope in any imported state. State selection uses the
          // membership table; state_filter on the shared identity is its first import state.
          await tx.query(
            `UPDATE npi_provider p SET in_scope=EXISTS(
            SELECT 1 FROM npi_state_scope s WHERE s.npi=p.npi AND s.in_scope)
            WHERE p.npi=ANY($1::text[]) AND p.in_scope IS DISTINCT FROM EXISTS(
              SELECT 1 FROM npi_state_scope s WHERE s.npi=p.npi AND s.in_scope)`,
            [batch.map((r) => r.npi)],
          );
          batch = [];
        };
        for await (const { get, rowNumber } of rows(
          input.main(),
          mainRequired,
        )) {
          report.read++;
          if (report.read % 1_000_000 === 0)
            options.progress?.(
              `NPPES scanned ${report.read}; kept ${report.kept}`,
            );
          const npi = get("NPI");
          if (!validNpi(npi)) {
            report.invalid++;
            report.skipped++;
            await issue(tx, snapshot, rowNumber, "main");
            continue;
          }
          const practice = mainAddress(get, "Practice Location");
          const inScope = practice.state === state || txSecondary.has(npi);
          if (!inScope && !known.has(npi)) {
            report.skipped++;
            continue;
          }
          // Redacted weekly deactivation rows must retain previously published identity/locations.
          if (
            known.has(npi) &&
            !get("Entity Type Code") &&
            get("NPI Deactivation Date")
          ) {
            const d = date(get("NPI Deactivation Date"));
            await tx.query(
              `INSERT INTO npi_deactivation(npi,deactivation_date,snapshot_id) VALUES($1,$2,$3)
              ON CONFLICT(npi) DO UPDATE SET deactivation_date=excluded.deactivation_date,snapshot_id=excluded.snapshot_id
              WHERE excluded.deactivation_date>npi_deactivation.deactivation_date`,
              [npi, d, snapshot],
            );
            report.kept++;
            continue;
          }
          if (
            !["1", "2"].includes(get("Entity Type Code")) &&
            !(get("Entity Type Code") === "" && get("NPI Deactivation Date"))
          )
            throw new Error("Invalid NPPES entity type");
          const deactivated = date(get("NPI Deactivation Date")),
            reactivated = date(get("NPI Reactivation Date"));
          const record: RecordValue = {
            npi,
            entity_type: nullable(get("Entity Type Code")),
            first_name: nullable(get("Provider First Name")),
            middle_name: nullable(get("Provider Middle Name")),
            last_name: nullable(get("Provider Last Name (Legal Name)")),
            name_prefix: nullable(get("Provider Name Prefix Text")),
            name_suffix: nullable(get("Provider Name Suffix Text")),
            credential: nullable(get("Provider Credential Text")),
            organization_name: nullable(
              get("Provider Organization Name (Legal Business Name)"),
            ),
            enumeration_date: date(get("Provider Enumeration Date")),
            last_update_date: date(get("Last Update Date")),
            deactivation_date: deactivated,
            reactivation_date: reactivated,
            deactivated:
              !!deactivated && (!reactivated || deactivated > reactivated),
            sole_proprietor: flag(get("Is Sole Proprietor")),
            in_scope: inScope,
            state_filter: state,
            data_date: dataDate,
            snapshot_id: snapshot,
            status_snapshot_id: snapshot,
          };
          record.addresses = [mainAddress(get, "Mailing"), practice]
            .filter(
              (a) =>
                a.line_1 ||
                a.line_2 ||
                a.city ||
                a.state ||
                a.postal_code ||
                a.country ||
                a.phone,
            )
            .map((a) => ({ ...a, npi, snapshot_id: snapshot }));
          record.taxonomies = Array.from({ length: 15 }, (_, i) => ({
            npi,
            ordinal: i + 1,
            code: get(`Healthcare Provider Taxonomy Code_${i + 1}`),
            is_primary: flag(
              get(`Healthcare Provider Primary Taxonomy Switch_${i + 1}`),
            ),
            license_state: nullable(
              get(`Provider License Number State Code_${i + 1}`),
            ),
            snapshot_id: snapshot,
          })).filter((t) => t.code);
          batch.push(record);
          report.kept++;
          if (batch.length >= 500) await flush();
        }
        await flush();
      }
      if (!report.read) throw new Error("Empty NPPES source");
      // Preserve the original identity snapshot while recording separate status provenance.
      await tx.query(`UPDATE npi_provider p SET deactivated=true,deactivation_date=d.deactivation_date,status_snapshot_id=d.snapshot_id
        FROM npi_deactivation d WHERE p.npi=d.npi AND (p.reactivation_date IS NULL OR p.reactivation_date<d.deactivation_date)
        AND (p.deactivation_date IS NULL OR p.deactivation_date<=d.deactivation_date)`);
      const counts = await tableCounts(tx);
      Object.assign(report, counts, { elapsed_ms: Date.now() - started });
      await tx.query(
        `INSERT INTO npi_import_run(snapshot_id,kind,state_filter,data_date,report) VALUES($1,$2,$3,$4,$5::jsonb)`,
        [snapshot, kind, state, dataDate, JSON.stringify(report)],
      );
      await tx.query(
        `UPDATE snapshot SET validation_state='ACTIVE',publisher_updated_at=$2,fetched_children=expected_children,activated_at=now() WHERE snapshot_id=$1`,
        [snapshot, dataDate],
      );
      return report;
    });
  } catch (error) {
    await db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=$1 AND validation_state<>'ACTIVE'",
      [snapshot],
    );
    throw error;
  }
}
