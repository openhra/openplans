#!/usr/bin/env node
import { homedir } from "node:os";
/** Read-only per-state HTTP validation against an explicitly selected loopback developer DB. */
import pg from "pg";
import { serve } from "@hono/node-server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "../../db/database.js";
import { createApp } from "../../api/app.js";
import type { SqlSession } from "../../db/database.js";

const cache =
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");
const url = process.env.OPENPLANS_QHP_DATABASE_URL;
const state = process.env.OPENPLANS_QHP_STATE ?? "TX";
const year = Number(process.env.OPENPLANS_QHP_YEAR ?? 2026);
const prefix =
  process.env.OPENPLANS_QHP_REPORT_PREFIX ??
  `qhp-${state.toLowerCase()}-${year}`;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !["postgres:", "postgresql:"].includes(new URL(url).protocol) ||
  !/^[A-Z]{2}$/.test(state) ||
  !Number.isInteger(year) ||
  year < 2014 ||
  year > 2100 ||
  !/^[a-z0-9-]+$/.test(prefix)
)
  throw new Error(
    "Explicit loopback developer DB, valid state/year and report prefix required",
  );
const pool = new pg.Pool({
  connectionString: url,
  max: 2,
  statement_timeout: 120_000,
});
pool.on("error", () => {});
const apiUrl = new URL(url);
apiUrl.searchParams.set("options", "-c statement_timeout=5000");
const api = createDatabase(apiUrl.href);
let timings: number[] = [];
const timed: SqlSession = {
  query: async <Row extends Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ) => {
    const start = Date.now();
    try {
      return await api.query<Row>(sql, args);
    } finally {
      timings.push(Date.now() - start);
    }
  },
  exec: (sql) => api.exec(sql),
};
const server = serve({
  fetch: createApp(timed).fetch,
  hostname: "127.0.0.1",
  port: 0,
});
const checks: Record<string, unknown>[] = [];
try {
  if (!server.listening)
    await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener");
  const base = `http://127.0.0.1:${address.port}`;
  const issuers = (
    await pool.query<{ issuer_id: string }>(
      `SELECT issuer_id FROM formulary_active_set WHERE state=$1 AND plan_year=$2
    UNION SELECT issuer_id FROM provider_active_set WHERE state=$1 AND plan_year=$2 ORDER BY issuer_id`,
      [state, year],
    )
  ).rows;
  for (const { issuer_id: issuer } of issuers) {
    const scope = [issuer, state, year];
    const fallback = (
      await pool.query<{ base_plan_id: string }>(
        `SELECT p.base_plan_id FROM puf_active_catalog a
      JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
      JOIN plan p ON p.snapshot_id=f.snapshot_id AND p.state=a.state AND p.plan_year=a.plan_year
      WHERE p.issuer_id=$1 AND a.state=$2 AND a.plan_year=$3 ORDER BY p.base_plan_id LIMIT 1`,
        scope,
      )
    ).rows[0]?.base_plan_id;
    const known = (
      await pool.query<{
        rxcui: string;
      }>(`SELECT c.rxcui FROM rx_concept c JOIN snapshot s USING(snapshot_id)
      WHERE s.validation_state='ACTIVE' AND c.suppress='N' LIMIT 1`)
    ).rows[0]?.rxcui;
    if (!fallback || !known)
      throw new Error("Missing ACTIVE catalog or RxNorm identity");
    const drug = (
      await pool.query<{ base_hios_id: string; rxcui: string }>(
        `SELECT e.base_hios_id,e.rxcui
      FROM formulary_active_set a JOIN formulary_shard f ON f.source_set_id=a.snapshot_id
      JOIN formulary_edge e ON e.snapshot_id=f.snapshot_id WHERE a.issuer_id=$1 AND a.state=$2 AND a.plan_year=$3
      AND EXISTS(SELECT 1 FROM rx_concept c JOIN snapshot s USING(snapshot_id)
        WHERE c.rxcui=e.rxcui AND c.suppress='N' AND s.validation_state='ACTIVE') LIMIT 1`,
        scope,
      )
    ).rows[0];
    const provider = (
      await pool.query<{ base_hios_id: string; npi: string; name: string }>(
        `WITH shards AS MATERIALIZED (
      SELECT s.snapshot_id FROM provider_active_set a JOIN provider_shard s ON s.source_set_id=a.snapshot_id
      WHERE a.issuer_id=$1 AND a.state=$2 AND a.plan_year=$3), candidates AS MATERIALIZED (
      (SELECT e.snapshot_id,e.record_id,e.base_hios_id FROM qhp_provider_plan_legacy e JOIN shards s USING(snapshot_id)
        WHERE e.evidence_status='listed_participating' LIMIT 5000)
      UNION ALL
      (SELECT l.snapshot_id,l.record_id,e.base_hios_id FROM provider_record_plan_group l JOIN shards s USING(snapshot_id)
        JOIN provider_plan_group_edge e USING(group_id) WHERE e.evidence_status='listed_participating' LIMIT 5000)
    ) SELECT c.base_hios_id,r.npi,coalesce(nullif(n.organization_name,''),nullif(n.last_name,''),nullif(n.first_name,'')) AS name
      FROM candidates c JOIN qhp_provider_record r USING(snapshot_id,record_id) JOIN npi_provider n ON n.npi=r.npi
      WHERE coalesce(nullif(n.organization_name,''),nullif(n.last_name,''),nullif(n.first_name,'')) IS NOT NULL LIMIT 1`,
        scope,
      )
    ).rows[0];
    const row: Record<string, unknown> = { issuer };
    for (const kind of ["drug", "provider"] as const) {
      const plan =
        kind === "drug"
          ? (drug?.base_hios_id ?? fallback)
          : (provider?.base_hios_id ?? fallback);
      const path =
        kind === "drug"
          ? `/v1/plans/${plan}/drugs/${drug?.rxcui ?? known}?year=${year}`
          : `/v1/providers?plan_id=${plan}&year=${year}${provider?.name ? `&name=${encodeURIComponent(provider.name)}` : ""}`;
      timings = [];
      const start = Date.now();
      const response = await fetch(base + path);
      const body = (await response.json()) as {
        status?: string;
        total?: number;
        providers?: { participation: string; nppes_snapshot_id?: string }[];
      };
      const elapsed = Date.now() - start;
      const valid =
        kind === "drug"
          ? drug
            ? body.status === "listed_covered"
            : ["unknown", "not_listed"].includes(body.status ?? "")
          : provider
            ? Number(body.total) > 0 &&
              body.providers?.every(
                (p) => p.participation === "listed_participating",
              )
            : body.total === 0;
      row[kind] = {
        plan,
        http_status: response.status,
        status: body.status,
        total: body.total,
        rxcui: kind === "drug" ? (drug?.rxcui ?? known) : undefined,
        elapsed_ms: elapsed,
        max_query_ms: Math.max(0, ...timings),
        sample_found: Boolean(kind === "drug" ? drug : provider),
        nppes_enriched:
          kind === "provider"
            ? (body.providers?.some((p) => Boolean(p.nppes_snapshot_id)) ??
              false)
            : undefined,
        pass: Boolean(response.ok && valid && elapsed < 5000),
      };
    }
    checks.push(row);
    console.log(JSON.stringify(row));
    await mkdir(join(cache, "reports"), { recursive: true });
    await writeFile(
      join(cache, "reports", `${prefix}-http.json`),
      JSON.stringify({ state, year, checks, running: true }, null, 2) + "\n",
    );
  }
  const manifest = (
    await pool.query(
      `SELECT * FROM qhp_coverage_manifest WHERE state=$1 AND plan_year=$2
    ORDER BY issuer_id,kind`,
      [state, year],
    )
  ).rows;
  const discovery = (
    await pool.query(
      `SELECT issuer_id,status,registry_snapshot_id,registry_row,snapshot_id,http_status
    FROM qhp_index WHERE state=$1 AND plan_year=$2 ORDER BY issuer_id,discovered_at`,
      [state, year],
    )
  ).rows;
  const identities = (
    await pool.query(`SELECT
    (SELECT count(*)::int FROM npi_provider) providers,(SELECT count(*)::int FROM npi_address) addresses,
    (SELECT count(*)::int FROM npi_taxonomy) taxonomies,(SELECT count(*)::int FROM rx_concept) rxnorm_atoms,
    pg_database_size(current_database())::text database_bytes,version() postgres,postgis_version() postgis`)
  ).rows[0];
  const scopes = (
    await pool.query(`SELECT state_filter,count(*)::int providers,
    count(*) FILTER(WHERE in_scope)::int in_scope FROM npi_state_scope GROUP BY state_filter ORDER BY state_filter`)
  ).rows;
  const attribution = (
    await pool.query(
      `WITH current_sets AS MATERIALIZED (
    SELECT s.* FROM provider_source_set s JOIN qhp_coverage_manifest m ON m.snapshot_id=s.snapshot_id AND m.kind='provider'
    WHERE s.state=$1 AND s.plan_year=$2), shards AS MATERIALIZED (
    SELECT f.*,s.issuer_id,s.state,s.plan_year FROM provider_shard f JOIN current_sets s ON s.snapshot_id=f.source_set_id
  ), weights AS (
    SELECT f.source_set_id,l.group_id,count(*)::bigint weight FROM shards f
    JOIN provider_record_plan_group l USING(snapshot_id) GROUP BY f.source_set_id,l.group_id
  ), counts AS (
    SELECT f.source_set_id,count(*)::bigint edges,
      count(*) FILTER(WHERE left(e.base_hios_id,5)<>f.issuer_id)::bigint wrong_issuer,
      count(*) FILTER(WHERE substring(e.base_hios_id,6,2)<>f.state)::bigint wrong_state,
      count(*) FILTER(WHERE e.plan_year<>f.plan_year)::bigint wrong_year
    FROM shards f JOIN qhp_provider_plan_legacy e USING(snapshot_id) GROUP BY f.source_set_id
    UNION ALL
    SELECT w.source_set_id,sum(w.weight)::bigint,
      coalesce(sum(w.weight) FILTER(WHERE left(e.base_hios_id,5)<>s.issuer_id),0)::bigint,
      coalesce(sum(w.weight) FILTER(WHERE substring(e.base_hios_id,6,2)<>s.state),0)::bigint,
      coalesce(sum(w.weight) FILTER(WHERE e.plan_year<>s.plan_year),0)::bigint
    FROM weights w JOIN current_sets s ON s.snapshot_id=w.source_set_id
    JOIN provider_plan_group_edge e USING(group_id) GROUP BY w.source_set_id
  ), actual AS (SELECT source_set_id,sum(edges) edges,sum(wrong_issuer) wrong_issuer,
    sum(wrong_state) wrong_state,sum(wrong_year) wrong_year FROM counts GROUP BY source_set_id),
  declared AS (SELECT source_set_id,sum(edge_count) edges FROM shards GROUP BY source_set_id)
  SELECT (SELECT count(*)::int FROM actual a FULL JOIN declared d USING(source_set_id)
    WHERE coalesce(a.edges,0)<>coalesce(d.edges,0)) logical_edge_mismatches,
    coalesce(sum(wrong_issuer),0)::int wrong_issuer,coalesce(sum(wrong_state),0)::int wrong_state,
    coalesce(sum(wrong_year),0)::int wrong_year,
    (SELECT count(*)::int FROM provider_plan_override o JOIN shards s USING(snapshot_id)) overrides,
    (SELECT count(*)::int FROM provider_plan_suppressed o JOIN shards s USING(snapshot_id)) suppressed
  FROM actual`,
      [state, year],
    )
  ).rows[0];
  const migrations = (
    await pool.query("SELECT name,sha256 FROM schema_migrations ORDER BY name")
  ).rows;
  await writeFile(
    join(cache, "reports", `${prefix}-database.json`),
    JSON.stringify(
      {
        state,
        year,
        manifest,
        discovery,
        identities,
        scopes,
        attribution,
        migrations,
      },
      null,
      2,
    ) + "\n",
  );
  if (Object.values(attribution ?? {}).some((v) => Number(v) !== 0))
    process.exitCode = 1;
  await writeFile(
    join(cache, "reports", `${prefix}-http.json`),
    JSON.stringify({ state, year, checks, running: false }, null, 2) + "\n",
  );
  if (
    checks.some((r) =>
      [r.drug, r.provider].some((c) => !(c as { pass: boolean }).pass),
    )
  )
    process.exitCode = 1;
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await api.close();
  await pool.end();
}
