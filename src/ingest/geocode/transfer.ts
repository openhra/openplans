import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { rowJson } from "../../db/row-provenance.js";
import { assertSnapshotAdmissible } from "../../fetch/index.js";
import { geocodeState, geocodeStates, checkCountyPoint } from "./counties.js";
import type { County } from "./counties.js";
import { createRun, stageStatewide, publishStatewide } from "./statewide.js";

type Row = Record<string, unknown>;
interface Header {
  version: 1;
  state: string;
  sourceRun: string;
  sources: Row[];
  snapshots: Row[];
  counties: County[];
}
const sources = new Set([
  "census-geocoder-batch",
  "census-county-outlines-2024",
  "census-zcta-gazetteer-2021",
]);
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
async function* lines(path: string) {
  const stream = createReadStream(path);
  try {
    for await (const line of createInterface({
      input: stream,
      crlfDelay: Infinity,
    }))
      yield line;
  } finally {
    stream.destroy();
  }
}

/** Verify retained public bytes and admission locally; never make a geocoder request. */
export async function verifyTransferSnapshot(snapshot: Row, root: string) {
  assert.equal(
    snapshot.validation_state,
    "ACTIVE",
    "inactive transfer evidence",
  );
  assert.ok(
    sources.has(String(snapshot.source_id)),
    "unsupported transfer source",
  );
  assert.match(String(snapshot.sha256), /^[a-f0-9]{64}$/);
  const dir = join(root, "raw", String(snapshot.source_id));
  const metadata = JSON.parse(
    await readFile(join(dir, snapshot.sha256 + ".meta.json"), "utf8"),
  );
  assert.equal(metadata.source, snapshot.source_id);
  assert.equal(metadata.snapshot_id, snapshot.sha256);
  assert.equal(metadata.sha256, snapshot.sha256);
  assert.equal(metadata.url, snapshot.requested_url);
  assert.equal(metadata.bytes, Number(snapshot.compressed_bytes));
  await assertSnapshotAdmissible(root, metadata);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(
    join(dir, metadata.sha256, "payload"),
  )) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  assert.equal(
    hash.digest("hex"),
    metadata.sha256,
    "transfer raw hash mismatch",
  );
  assert.equal(bytes, metadata.bytes);
}

/** Export only a completed state queue, in one read-only consistent source transaction. */
export async function exportGeocodes(
  db: Database,
  runId: string,
  path: string,
) {
  const file = await open(path + ".part", "wx");
  const hash = createHash("sha256");
  let count = 0;
  const write = async (row: unknown) => {
    const line = JSON.stringify(row) + "\n";
    hash.update(line);
    await file.write(line);
  };
  try {
    await db.transaction(async (tx) => {
      await tx.exec(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      );
      const run = (
        await tx.query("SELECT * FROM geocode_tx_run WHERE run_id=$1", [runId])
      ).rows[0];
      assert.ok(
        run?.npi_staged && run.issuer_staged,
        "source queue not staged",
      );
      const state = geocodeState(String(run.state));
      const missing = (
        await tx.query(
          `SELECT count(*)::int n FROM geocode_tx_address a
        WHERE run_id=$1 AND NOT EXISTS(SELECT 1 FROM geocode_tx_result r WHERE r.address_hash=a.address_hash)`,
          [runId],
        )
      ).rows[0];
      assert.equal(missing?.n, 0, "source queue incomplete");
      const counties = (
        await tx.query(
          `SELECT ${rowJson("c")} AS row FROM geocode_tx_county c WHERE county_fips LIKE $1 ORDER BY county_fips`,
          [geocodeStates[state].fips + "%"],
        )
      ).rows.map((r) => r.row) as County[];
      const snapshots = (
        await tx.query(
          `WITH ids AS (
        SELECT unnest(ARRAY[r.snapshot_id,r.centroid_snapshot_id,r.bounds_snapshot_id]) id
        FROM geocode_tx_result r JOIN geocode_tx_address a USING(address_hash) WHERE a.run_id=$1
        UNION SELECT snapshot_id FROM geocode_tx_county WHERE county_fips LIKE $2)
        SELECT ${rowJson("s")} AS row FROM snapshot s WHERE snapshot_id IN(SELECT id FROM ids) ORDER BY snapshot_id`,
          [runId, geocodeStates[state].fips + "%"],
        )
      ).rows.map((r) => r.row) as Row[];
      const sourceRows = (
        await tx.query(
          `SELECT ${rowJson("s")} AS row FROM source s WHERE source_id=ANY($1) ORDER BY source_id`,
          [[...new Set(snapshots.map((s) => s.source_id))]],
        )
      ).rows.map((r) => r.row) as Row[];
      await write({
        version: 1,
        state,
        sourceRun: runId,
        sources: sourceRows,
        snapshots,
        counties,
      });
      let cursor = "";
      for (;;) {
        const page = (
          await tx.query(
            `SELECT ${rowJson("r")} AS row FROM geocode_tx_address a
          JOIN geocode_tx_result r USING(address_hash) WHERE a.run_id=$1 AND a.address_hash>$2
          ORDER BY a.address_hash LIMIT 2000`,
            [runId, cursor],
          )
        ).rows.map((r) => r.row) as Row[];
        if (!page.length) break;
        for (const row of page) await write(row);
        count += page.length;
        cursor = String(page[page.length - 1]!.address_hash);
      }
      assert.ok(count > 0, "empty source queue");
      await file.write(
        JSON.stringify({ end: true, count, sha256: hash.digest("hex") }) + "\n",
      );
    });
    await file.close();
    await rename(path + ".part", path);
    return { runId, count, path };
  } catch (error) {
    await file.close();
    await rm(path + ".part", { force: true });
    throw error;
  }
}

function checkResult(row: Row, header: Header) {
  const address = JSON.parse(String(row.normalized_address));
  assert.equal(address[3], header.state, "transfer address state mismatch");
  assert.equal(
    digest(String(row.normalized_address)),
    row.address_hash,
    "transfer address hash mismatch",
  );
  for (const field of [
    "snapshot_id",
    "centroid_snapshot_id",
    "bounds_snapshot_id",
  ])
    if (row[field])
      assert.ok(
        header.snapshots.some((s) => s.snapshot_id === row[field]),
        "transfer evidence missing",
      );
  assert.ok(
    [null, "census_geocoder", "zcta_centroid"].includes(
      row.method as null | string,
    ),
  );
  if (row.method === "census_geocoder") {
    assert.equal(row.match_status, "Match");
    assert.ok(["Exact", "Non_Exact"].includes(String(row.match_quality)));
  }
  if (row.method === "zcta_centroid") {
    assert.ok(row.centroid_snapshot_id, "unlabelled centroid");
    assert.equal(row.match_quality, null, "false centroid quality");
  }
  if (row.method !== null) {
    assert.equal(typeof row.latitude, "number");
    assert.equal(typeof row.longitude, "number");
    checkCountyPoint(
      Number(row.latitude),
      Number(row.longitude),
      String(row.county_fips),
      header.counties,
    );
  }
}

/** Validate the entire transport and all public evidence before mutating the target. */
export async function inspectGeocodes(
  path: string,
  verify: (s: Row) => Promise<void>,
) {
  const hash = createHash("sha256");
  let header: Header | undefined,
    ended = false,
    count = 0,
    cursor = "";
  for await (const line of lines(path)) {
    assert.ok(!ended, "trailing transfer data");
    const row = JSON.parse(line);
    if (!header) {
      assert.equal(row.version, 1);
      geocodeState(row.state);
      header = row as Header;
      assert.equal(
        header.counties.length,
        geocodeStates[geocodeState(header.state)].counties,
      );
      assert.ok(header.snapshots.length > 0);
      for (const snapshot of header.snapshots) await verify(snapshot);
    } else if (row.end === true) {
      assert.equal(row.count, count);
      assert.ok(count > 0);
      assert.equal(
        row.sha256,
        hash.digest("hex"),
        "transfer checksum mismatch",
      );
      ended = true;
      continue;
    } else {
      checkResult(row, header);
      assert.ok(
        row.address_hash > cursor,
        "transfer rows must be unique and sorted",
      );
      cursor = row.address_hash;
      count++;
    }
    hash.update(line + "\n");
  }
  assert.ok(header && ended, "truncated geocode transfer");
  return { header, count };
}

async function insertRows(tx: SqlSession, table: string, rows: unknown[]) {
  await tx.query(
    `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
    [JSON.stringify(rows)],
  );
}

/** Merge immutable observations, then use normal staging/publication for current source keys. */
export async function importGeocodes(
  db: Database,
  path: string,
  runId: string,
  root: string,
  verify = (s: Row) => verifyTransferSnapshot(s, root),
) {
  const { header, count } = await inspectGeocodes(path, verify);
  const scope = (
    await db.query(`SELECT
    ARRAY(SELECT snapshot_id FROM npi_import_run ORDER BY snapshot_id) nppes,
    ARRAY(SELECT s.snapshot_id FROM provider_shard s JOIN provider_active_set a ON a.snapshot_id=s.source_set_id
      JOIN snapshot snap ON snap.snapshot_id=s.snapshot_id WHERE snap.validation_state='ACTIVE' ORDER BY s.snapshot_id) shards`)
  ).rows[0];
  const signature = digest(
    JSON.stringify({ state: header.state, sourceRun: header.sourceRun, scope }),
  );
  const existing = (
    await db.query(
      "SELECT scope_signature FROM geocode_tx_run WHERE run_id=$1",
      [runId],
    )
  ).rows[0];
  if (existing)
    assert.equal(
      existing.scope_signature,
      signature,
      "target scope changed; use a new run ID",
    );
  await createRun(db, runId, false, header.state);
  await db.query(
    "UPDATE geocode_tx_run SET scope_signature=$2 WHERE run_id=$1",
    [runId, signature],
  );
  const snapshots = header.snapshots.map((s) => ({
    ...s,
    raw_path: join(
      root,
      "raw",
      String(s.source_id),
      String(s.sha256),
      "payload",
    ),
  }));
  await db.transaction(async (tx) => {
    await insertRows(tx, "source", header.sources);
    await insertRows(tx, "snapshot", snapshots);
    const conflicts = (
      await tx.query(
        `SELECT count(*)::int n FROM snapshot s
      JOIN jsonb_populate_recordset(NULL::snapshot,$1::jsonb) x USING(snapshot_id)
      WHERE s.validation_state IS DISTINCT FROM x.validation_state
        OR (s.source_id,s.sha256,s.requested_url,s.compressed_bytes)
        IS DISTINCT FROM (x.source_id,x.sha256,x.requested_url,x.compressed_bytes)`,
        [JSON.stringify(header.snapshots)],
      )
    ).rows[0];
    assert.equal(conflicts?.n, 0, "conflicting target evidence");
    await insertRows(tx, "geocode_tx_county", header.counties);
  });
  // Re-stage each target address. Source NPIs, ordinals and snapshot IDs are never transplanted.
  await stageStatewide(db, { runId, state: header.state });
  let page: Row[] = [];
  async function flush() {
    if (!page.length) return;
    await db.transaction(async (tx) => {
      const conflict = (
        await tx.query(
          `SELECT count(*)::int n FROM geocode_tx_result r
        JOIN jsonb_populate_recordset(NULL::geocode_tx_result,$1::jsonb) x USING(address_hash)
        WHERE ${rowJson("r")} IS DISTINCT FROM ${rowJson("x")}`,
          [JSON.stringify(page)],
        )
      ).rows[0];
      assert.equal(conflict?.n, 0, "conflicting target observation");
      await insertRows(tx, "geocode_tx_result", page);
      await publishStatewide(
        tx,
        runId,
        page.map((r) => String(r.address_hash)),
      );
    });
    page = [];
  }
  let first = true;
  for await (const line of lines(path)) {
    if (first) {
      first = false;
      continue;
    }
    const row = JSON.parse(line);
    if (row.end === true) break;
    page.push(row);
    if (page.length === 2000) await flush();
  }
  await flush();
  const status = (
    await db.query<{ addresses: number; pending: number }>(
      `SELECT count(*)::int addresses,
    count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM geocode_tx_result r WHERE r.address_hash=a.address_hash))::int pending
    FROM geocode_tx_address a WHERE run_id=$1`,
      [runId],
    )
  ).rows[0];
  assert.ok(Number(status?.addresses) > 0, "target queue empty");
  assert.equal(
    status?.pending,
    0,
    "target has addresses absent from transfer; no requests made",
  );
  return { state: header.state, runId, imported: count, ...status };
}
