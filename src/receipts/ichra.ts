import { IMPORT_KINDS } from "../ingest/puf/import-source.js";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import type { SqlSession } from "../db/database.js";
import { dataGeneration } from "../api/cache/generation.js";
import { boundedDatabase } from "../db/bounded.js";
import {
  CensusError,
  censusRows,
  ichraAffordabilityBatch,
} from "../services/ichra-batch.js";
import { ichraRegistry } from "../domain/ichra/generated.js";
import { parameterRegistry } from "../domain/subsidy/generated.js";
import { canonicalJson, sha256, serializeEvidence } from "./evidence.js";
import type { Dependencies } from "./evidence.js";

let engineIdentity: Promise<Dependencies["engine"]> | undefined;
async function identifyEngine(): Promise<Dependencies["engine"]> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entries: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(js|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
        entries.push(
          `${relative(root, path)}\0${sha256(await readFile(path))}`,
        );
    }
  };
  for (const directory of [
    "api",
    "db",
    "domain",
    "ingest",
    "services",
    "receipts",
  ])
    await walk(join(root, directory));
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const lock = await readFile(
    new URL("../../package-lock.json", import.meta.url),
  );
  return {
    version: pkg.version,
    sha256: sha256(
      canonicalJson({
        files: entries.sort(),
        dependencies: sha256(lock),
        node: process.versions.node,
      }),
    ),
  };
}

export async function receiptIdentity() {
  return {
    rule_hash: sha256(canonicalJson({ ichraRegistry, parameterRegistry })),
    engine: await (engineIdentity ??= identifyEngine()),
  };
}

/** Conservative manifest: all active public snapshots, including absence/completeness evidence. */
export async function receiptDependencies(
  db: SqlSession,
): Promise<Dependencies> {
  const generation = await dataGeneration(db);
  const { rows } = await db.query<{
    snapshot_id: string;
    source_id: string;
    sha256: string;
  }>(
    `SELECT snapshot_id,source_id,sha256 FROM snapshot WHERE validation_state='ACTIVE' ORDER BY snapshot_id COLLATE "C"`,
  );
  const { rows: members } = await db.query<{
    import_id: string;
    kind: string;
    snapshot_id: string;
    sha256: string;
  }>(
    `SELECT f.import_id,f.kind,f.snapshot_id,s.sha256 FROM puf_import_file f JOIN snapshot s ON s.snapshot_id=f.snapshot_id WHERE f.import_id=ANY($1::text[])`,
    [rows.map((row) => row.snapshot_id)],
  );
  const snapshots = rows.map((row) => {
    const files = IMPORT_KINDS.flatMap((kind) =>
      members
        .filter(
          (member) =>
            member.import_id === row.snapshot_id && member.kind === kind,
        )
        .map(({ kind, snapshot_id, sha256 }) => ({
          kind,
          snapshot_id,
          sha256,
        })),
    );
    return files.length &&
      sha256(JSON.stringify(files.map((file) => [file.kind, file.sha256]))) ===
        row.sha256
      ? { ...row, members: files }
      : row;
  });
  if (generation !== (await dataGeneration(db)))
    throw new CensusError("GENERATION_CHANGED");
  return {
    generation,
    snapshots,
    ...(await receiptIdentity()),
  };
}

export async function prepareIchraReceipt(
  db: SqlSession,
  input: unknown,
  includeInput: boolean,
  signal: AbortSignal,
) {
  const rows = censusRows(input);
  const read = async (session: SqlSession) => {
    const bounded = boundedDatabase(session, signal, { readOnly: true });
    const dependencies = await receiptDependencies(bounded);
    const answer = await ichraAffordabilityBatch(bounded, rows, signal);
    if (
      dependencies.generation !== answer.provenance.generation ||
      dependencies.generation !== (await dataGeneration(bounded))
    )
      throw new CensusError("GENERATION_CHANGED");
    signal.throwIfAborted();
    return serializeEvidence(input, answer, dependencies, includeInput);
  };
  if (db.withRequest)
    return db.withRequest(signal, async (session) => {
      await session.exec(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return read(session);
    });
  return read(db);
}
