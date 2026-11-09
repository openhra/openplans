import { homedir } from "node:os";
/** Offline cuts of cached Cigna, PUF and NLM data. Build first: npm run build. */
import { PGlite } from "@electric-sql/pglite";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArray } from "../../../../dist/ingest/json/index.js";
const cache =
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");
const out = dirname(fileURLToPath(import.meta.url));
const lineage = [];
async function cached(kind) {
  const dir = join(cache, "raw", `qhp-76589-2026-${kind}`);
  const names = (await readdir(dir))
    .filter((n) => n.endsWith(".meta.json"))
    .sort();
  if (names.length !== 1)
    throw new Error("Select an unambiguous cached version before regenerating");
  const metadata = JSON.parse(await readFile(join(dir, names[0]), "utf8"));
  const path = join(dir, metadata.snapshot_id, "payload");
  const hash = createHash("sha256");
  async function* bytes() {
    for await (const b of createReadStream(path)) {
      hash.update(b);
      yield b;
    }
  }
  return { metadata, hash, records: readJsonArray(bytes()) };
}
const selected = [],
  indexes = [];
const drugs = await cached("formulary_urls");
let index = 0;
const wanted = ["METFORMIN ", "LISINOPRIL ", "ATORVASTATIN "];
for await (const drug of drugs.records) {
  const match = wanted.find((name) =>
    drug.drug_name.toUpperCase().startsWith(name),
  );
  if (
    match &&
    !selected.some((d) => d.drug_name.toUpperCase().startsWith(match))
  ) {
    selected.push(drug);
    indexes.push(index);
  }
  index++;
}
if (selected.length !== 3 || drugs.hash.digest("hex") !== drugs.metadata.sha256)
  throw new Error("Drug cut/hash failure");
lineage.push({
  kind: "drugs",
  sha256: drugs.metadata.sha256,
  url: drugs.metadata.url,
  source_record_indexes: indexes,
});
const definitions = [],
  plans = await cached("plan_urls");
for await (const p of plans.records) {
  if (p.plan_id.startsWith("76589TX"))
    definitions.push({
      plan_id: p.plan_id,
      plan_id_type: p.plan_id_type,
      years: p.years,
      formulary: p.formulary.map((t) => ({ drug_tier: t.drug_tier })),
    });
}
if (plans.hash.digest("hex") !== plans.metadata.sha256)
  throw new Error("Plan hash failure");
lineage.push({
  kind: "plan_definitions",
  sha256: plans.metadata.sha256,
  url: plans.metadata.url,
  projection:
    "plan_id, plan_id_type, years, formulary[].drug_tier; contact fields excluded",
});
const puf = new PGlite(join(cache, "puf-pglite-p1d"));
const catalog = (
  await puf.query(`SELECT p.* FROM puf_active_catalog a
 JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
 JOIN plan p ON p.snapshot_id=f.snapshot_id WHERE a.state='TX' AND a.plan_year=2026 AND p.issuer_id='76589'
 ORDER BY p.base_plan_id`)
).rows;
const variants = (
  await puf.query(
    `SELECT variant_plan_id,base_plan_id,csr_suffix,csr_variation_type,variant_name,
 source_row,exchange_status FROM plan_variant WHERE snapshot_id=$1 AND issuer_id='76589' ORDER BY variant_plan_id`,
    [catalog[0].snapshot_id],
  )
).rows;
lineage.push({
  kind: "catalog",
  snapshot_id: catalog[0].snapshot_id,
  source: (
    await puf.query(
      "SELECT sha256,requested_url FROM snapshot WHERE snapshot_id=$1",
      [catalog[0].snapshot_id],
    )
  ).rows[0],
});
await puf.close();
const rx = new PGlite(join(cache, "rxnorm-pglite-p2a"));
const concepts = (
  await rx.query(
    `SELECT c.* FROM rx_concept c JOIN snapshot s USING(snapshot_id)
 WHERE s.validation_state='ACTIVE' AND c.rxcui=ANY($1::text[]) ORDER BY c.rxaui`,
    [[...selected.map((d) => d.rxnorm_id), "6809"]],
  )
).rows;
lineage.push({
  kind: "rxnorm",
  snapshot_id: concepts[0].snapshot_id,
  source: (
    await rx.query(
      "SELECT sha256,requested_url FROM snapshot WHERE snapshot_id=$1",
      [concepts[0].snapshot_id],
    )
  ).rows[0],
});
await rx.close();
for (const [name, data] of Object.entries({
  "drugs.json": selected,
  "plans.json": definitions,
  "catalog.json": { plans: catalog, variants },
  "rxnorm.json": concepts,
  "provenance.json": {
    synthetic: false,
    lineage,
    note: "Drugs retain all real TX and non-TX associations; indexes refer to original feed. Other files are stated projections.",
  },
})) {
  const text = JSON.stringify(data, null, 2) + "\n";
  if (Buffer.byteLength(text) >= 200_000)
    throw new Error(`Oversize fixture: ${name}`);
  await writeFile(join(out, name), text);
}
console.log(
  JSON.stringify({
    drugs: selected.map((d) => [d.rxnorm_id, d.drug_name]),
    plans: catalog.length,
    variants: variants.length,
    rx_atoms: concepts.length,
    source_records: indexes,
  }),
);
