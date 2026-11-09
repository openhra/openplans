import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import type { SqlSession } from "../../../src/db/database.js";

export const scope = { issuer: "76589", state: "TX", year: 2026 };
const fixtures = fileURLToPath(
  new URL("../../fixtures/qhp/formulary/", import.meta.url),
);
export const fixture = async (name: string) =>
  JSON.parse(await readFile(join(fixtures, `${name}.json`), "utf8"));
export async function insert(
  db: SqlSession,
  table: string,
  row: Record<string, unknown>,
) {
  const keys = Object.keys(row);
  await db.query(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
    keys.map((k) =>
      row[k] !== null && typeof row[k] === "object"
        ? JSON.stringify(row[k])
        : row[k],
    ),
  );
}
export async function setup() {
  const pg = new PGlite(),
    db = testDatabase(pg),
    core = await coreMigrations();
  await migrate(db, core.directory);
  const directory = await mkdtemp(join(tmpdir(), "openplans-formulary-"));
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-harness','synthetic fixture harness','test')`,
  );
  for (const id of ["catalog-import", "catalog", "registry", "index", "rx"])
    await db.query(
      `INSERT INTO snapshot
    (snapshot_id,source_id,sha256,retrieved_at,expected_children,fetched_children,validation_state,activated_at)
    VALUES ($1,'synthetic-harness',$2,now(),0,0,'ACTIVE',now())`,
      [id, "a".repeat(64)],
    );
  await db.query(
    `INSERT INTO puf_import(import_id,state,plan_year) VALUES ('catalog-import','TX',2026)`,
  );
  await db.query(
    `INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES ('catalog-import','plan-attributes','catalog')`,
  );
  await db.query(
    `INSERT INTO puf_active_catalog VALUES ('TX',2026,'catalog-import')`,
  );
  const catalog = await fixture("catalog");
  for (const plan of catalog.plans)
    await insert(db, "plan", { ...plan, snapshot_id: "catalog" });
  for (const variant of catalog.variants)
    await insert(db, "plan_variant", {
      ...variant,
      snapshot_id: "catalog",
      state: "TX",
      plan_year: 2026,
      issuer_id: "76589",
      raw: {},
    });
  await db.query(
    `INSERT INTO rx_release(snapshot_id,source_version) VALUES ('rx','2026-11-02')`,
  );
  for (const concept of await fixture("rxnorm"))
    await insert(db, "rx_concept", { ...concept, snapshot_id: "rx" });
  await db.query(`INSERT INTO qhp_index(qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,registry_row,snapshot_id,status)
    VALUES ('index-row','discovery','76589',2026,'TX','registry',1,'index','ok')`);
  let childNumber = 0,
    indexId = "index-row";
  async function child(value: unknown, kind = "formulary_urls", text?: string) {
    const number = ++childNumber,
      path = join(directory, `synthetic-harness-child-${number}.json`);
    const bytes = Buffer.from(text ?? JSON.stringify(value));
    await writeFile(path, bytes);
    const snapshot = `child-${number}`,
      sha = createHash("sha256").update(bytes).digest("hex");
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id,raw_path,sha256,retrieved_at,expected_children,validation_state,final_url)
      VALUES ($1,'synthetic-harness',$2,$3,now(),0,'FETCHING',$4)`,
      [
        snapshot,
        path,
        sha,
        `https://www.cigna.com/synthetic-harness-${number}.json`,
      ],
    );
    await db.query(
      `INSERT INTO qhp_child_url(qhp_index_id,issuer_id,plan_year,kind,url,published_url,url_sha256,host_evidence,
      index_snapshot_id,snapshot_id,status) VALUES ($5,'76589',2026,$1,$2,$2,$3,'index_child','index',$4,'downloaded')`,
      [
        kind,
        `https://www.cigna.com/synthetic-harness-${number}.json`,
        sha,
        snapshot,
        indexId,
      ],
    );
    return snapshot;
  }
  await child(await fixture("plans"), "plan_urls");
  async function replace(drugs: unknown, text?: string) {
    const previous = indexId;
    indexId = `index-${childNumber}`;
    await db.query(
      `INSERT INTO qhp_index(qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,
      registry_row,snapshot_id,status,discovered_at) VALUES ($1,$1,'76589',2026,'TX','registry',1,'index','ok',clock_timestamp())`,
      [indexId],
    );
    await db.query(
      `INSERT INTO qhp_child_url(qhp_index_id,issuer_id,plan_year,kind,url,published_url,url_sha256,
      host_evidence,index_snapshot_id,snapshot_id,status)
      SELECT $1,issuer_id,plan_year,kind,url,published_url,url_sha256,host_evidence,index_snapshot_id,snapshot_id,status
      FROM qhp_child_url WHERE qhp_index_id=$2 AND kind='plan_urls'`,
      [indexId, previous],
    );
    return child(drugs, "formulary_urls", text);
  }
  return {
    db,
    core,
    directory,
    child,
    replace,
    catalog,
    close: async () => {
      await db.close();
      await core.cleanup();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
