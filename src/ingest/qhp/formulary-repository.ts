import type { SqlSession } from "../../db/database.js";

export interface FormularyScope {
  issuer: string;
  year: number;
  state: string;
}
export interface CachedChild extends Record<string, unknown> {
  child_id: string;
  snapshot_id: string | null;
  raw_path: string | null;
  sha256: string | null;
  status: string;
  kind: string;
  url: string;
  url_sha256: string;
  http_status: number | null;
  compressed_bytes: string | null;
}
export async function sourceSet(db: SqlSession, scope: FormularyScope) {
  // Select a single discovery run, including all registry rows from that run.
  const indexes = (
    await db.query<{ discovery_id: string; status: string }>(
      `SELECT discovery_id,status FROM qhp_index
    WHERE issuer_id=$1 AND plan_year=$2 AND state=$3
    ORDER BY discovered_at DESC,qhp_index_id DESC`,
      [scope.issuer, scope.year, scope.state],
    )
  ).rows;
  const discovery = indexes[0]?.discovery_id ?? null;
  const children = (
    await db.query<CachedChild>(
      `SELECT c.qhp_child_url_id::text AS child_id,c.snapshot_id,
      s.raw_path,s.sha256,c.status,c.kind,c.url,c.url_sha256,c.http_status,s.compressed_bytes FROM qhp_child_url c JOIN qhp_index i USING(qhp_index_id)
      LEFT JOIN snapshot s ON s.snapshot_id=c.snapshot_id
      WHERE i.discovery_id=$1 AND i.issuer_id=$2 AND i.plan_year=$3 AND i.state=$4
      ORDER BY c.qhp_child_url_id`,
      [discovery, scope.issuer, scope.year, scope.state],
    )
  ).rows;
  return {
    discovery,
    indexStatuses: indexes
      .filter((i) => i.discovery_id === discovery)
      .map((i) => i.status),
    indexesOk:
      !!discovery &&
      indexes
        .filter((i) => i.discovery_id === discovery)
        .every((i) => i.status === "ok"),
    children: children.filter(
      (child, at) =>
        children.findIndex(
          (c) => c.kind === child.kind && c.url_sha256 === child.url_sha256,
        ) === at,
    ),
  };
}
export async function catalogPlans(db: SqlSession, scope: FormularyScope) {
  return (
    await db.query<{
      base_plan_id: string;
      snapshot_id: string;
      market: string;
    }>(
      `SELECT p.base_plan_id,p.snapshot_id,p.market
    FROM puf_active_catalog a JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
    JOIN plan p ON p.snapshot_id=f.snapshot_id AND p.state=a.state AND p.plan_year=a.plan_year
    WHERE a.state=$1 AND a.plan_year=$2 AND p.issuer_id=$3`,
      [scope.state, scope.year, scope.issuer],
    )
  ).rows;
}
export async function beginSourceSet(
  db: SqlSession,
  scope: FormularyScope,
  id: string,
  discovery: string | null,
  sha: string,
  expected: number,
  catalog: string | null,
) {
  const source = `qhp-formulary-${scope.issuer}-${scope.year}-${scope.state}`;
  await db.query(
    `INSERT INTO source(source_id,publisher,issuer_scope,source_kind,registry_evidence)
    VALUES ($1,'QHP issuer publication',$2,'qhp-formulary',$3) ON CONFLICT DO NOTHING`,
    [
      source,
      JSON.stringify([scope.issuer]),
      JSON.stringify({ discovery_id: discovery }),
    ],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,parser_version,expected_children,validation_state)
    VALUES ($1,$2,$3,now(),'qhp-formulary-v3',$4,'FETCHING')`,
    [id, source, sha, expected],
  );
  await db.query(
    `INSERT INTO formulary_source_set(snapshot_id,issuer_id,plan_year,state,discovery_id,catalog_snapshot_id)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, scope.issuer, scope.year, scope.state, discovery, catalog],
  );
}
export async function beginShard(
  db: SqlSession,
  id: string,
  set: string,
  child: CachedChild,
) {
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,
    publisher_updated_at,http_status,etag,last_modified,content_type,compressed_bytes,sha256,raw_path,
    parser_version,expected_children,validation_state)
    SELECT $1,source_id,requested_url,final_url,redirect_chain,retrieved_at,publisher_updated_at,http_status,
    etag,last_modified,content_type,compressed_bytes,sha256,raw_path,'qhp-formulary-v3',0,'FETCHING'
    FROM snapshot WHERE snapshot_id=$2`,
    [id, child.snapshot_id],
  );
  // Missing/unfetched children still have a quarantinable attempt snapshot.
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,parser_version,expected_children,validation_state)
    SELECT $1,source_id,'qhp-formulary-v3',0,'FETCHING' FROM snapshot WHERE snapshot_id=$2
    ON CONFLICT DO NOTHING`,
    [id, set],
  );
  await db.query(
    `INSERT INTO formulary_shard(source_set_id,child_id,snapshot_id,raw_snapshot_id,status,reason)
    VALUES ($1,$2,$3,$4,'failed','not_parsed')`,
    [set, child.child_id, id, child.snapshot_id],
  );
}
export async function insertEdges(db: SqlSession, rows: unknown[][]) {
  if (!rows.length) return;
  const values: unknown[] = [];
  const groups = rows.map(
    (row) =>
      `(${row
        .map((value) => {
          values.push(value);
          return `$${values.length}`;
        })
        .join(",")})`,
  );
  await db.query(
    `INSERT INTO formulary_edge(snapshot_id,source_record,source_plan_index,rxcui,base_hios_id,
    plan_year,drug_tier,prior_authorization,step_therapy,quantity_limit,source_updated_at,tier_status) VALUES ${groups.join(",")}`,
    values,
  );
}
export async function saveIssues(
  db: SqlSession,
  snapshot: string,
  issues: Map<string, { count: number; first: number | null }>,
) {
  for (const [code, issue] of issues)
    await db.query(
      `INSERT INTO quality_issue(snapshot_id,source_record,severity,issue_code,explanation)
    VALUES ($1,$2,'warning',$3,$4)`,
      [
        snapshot,
        issue.first === null ? null : String(issue.first),
        code,
        JSON.stringify({
          count: issue.count,
          first_source_record: issue.first,
        }),
      ],
    );
}
export async function publishSet(
  db: SqlSession,
  scope: FormularyScope,
  id: string,
  status: "complete" | "partial" | "failed" | "access_denied" | "unknown",
  reason: string,
  expected: number,
  complete: number,
  markets: string[],
  publishPositive = status === "complete",
) {
  const active = publishPositive;
  await db.query(
    `UPDATE snapshot SET validation_state=$2,fetched_children=$3,activated_at=CASE WHEN $4 THEN now() ELSE NULL END
    WHERE snapshot_id=$1`,
    [id, active ? "ACTIVE" : "QUARANTINED", complete, active],
  );
  if (active) {
    await db.query(
      `INSERT INTO formulary_active_set(issuer_id,plan_year,state,snapshot_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT(issuer_id,plan_year,state) DO UPDATE SET snapshot_id=excluded.snapshot_id`,
      [scope.issuer, scope.year, scope.state, id],
    );
    await db.query(
      `UPDATE snapshot SET validation_state='ACTIVE',activated_at=now() WHERE snapshot_id IN
      (SELECT snapshot_id FROM formulary_shard WHERE source_set_id=$1)`,
      [id],
    );
  } else {
    await db.query(
      `UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id IN
      (SELECT snapshot_id FROM formulary_shard WHERE source_set_id=$1)`,
      [id],
    );
  }
  await db.query(
    `INSERT INTO qhp_coverage_manifest(issuer_id,plan_year,state,kind,status,reason,snapshot_id,expected_children,complete_children)
    VALUES ($1,$2,$3,'drug',$4,$5,$6,$7,$8) ON CONFLICT(issuer_id,plan_year,state,kind) DO UPDATE SET
    status=excluded.status,reason=excluded.reason,snapshot_id=excluded.snapshot_id,
    expected_children=excluded.expected_children,complete_children=excluded.complete_children,updated_at=now()`,
    [
      scope.issuer,
      scope.year,
      scope.state,
      status,
      reason,
      id,
      expected,
      complete,
    ],
  );
  for (const market of markets)
    await db.query(
      `INSERT INTO data_availability(state,plan_year,market,issuer_id,formulary_status,snapshot_id)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(state,plan_year,market,issuer_id) DO UPDATE SET
    formulary_status=excluded.formulary_status`,
      [
        scope.state,
        scope.year,
        market,
        scope.issuer,
        active ? "available" : "unknown",
        id,
      ],
    );
}
