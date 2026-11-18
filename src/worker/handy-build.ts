import type { Database, SqlSession, QueryOptions } from "../db/database.js";
import type { LowestInput } from "../api/handy.js";
import { lowestInput, lowestQuery } from "../api/handy.js";
import { resolveLocation } from "../api/repository.js";
import {
  enumerateLowest,
  acceptsLowestCell,
  type LowestCell,
} from "../services/handy.js";
import {
  handyManifest,
  lowestBuildGroups,
  countyLowestInput,
  lowestEvidenceKey,
  readLowestEvidence,
  readLowestGroup,
  publishLowestCells,
  handyKey,
  type CompactLowest,
} from "../db/handy-repository.js";
import { requestReads } from "../services/request-reads.js";
import { loadConfig } from "../config/index.js";

/** Identical SQL can be reused across ages only inside this repeatable-read build. */
function countyBuildReads(tx: SqlSession): SqlSession {
  const cache = new Map<
    string,
    Promise<{ rows: Record<string, unknown>[]; jsonColumns?: string[] }>
  >();
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      for (const entry of Object.values(value)) freeze(entry);
      Object.freeze(value);
    }
  };
  return {
    ...tx,
    async query<Row extends Record<string, unknown>>(
      sql: string,
      values?: unknown[],
      options?: QueryOptions,
    ) {
      const key = JSON.stringify([sql, values, options]);
      let answer = cache.get(key);
      if (!answer) {
        answer = tx
          .query(sql, values, options)
          .then(({ rows, jsonColumns }) => {
            freeze(rows);
            return { rows, jsonColumns };
          });
        cache.set(key, answer);
      }
      const { rows, jsonColumns } = await answer;
      return { rows: rows.map((row) => ({ ...row })) as Row[], jsonColumns };
    },
  };
}

/** One county/year transaction shares reads and evidence across the requested ages. */
export async function buildLowestCounty(
  db: Database,
  values: LowestInput[],
  maxCells?: number,
  renewBeforeMs = 0,
) {
  if (!values.length) throw new Error("Empty county publication");
  const inputs = values.map(countyLowestInput),
    first = inputs[0]!;
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await tx.query("SELECT pg_advisory_xact_lock(1869636991)");
    await tx.query(
      "SELECT table_name FROM api_data_generation WHERE table_name NOT LIKE 'handy_lowest_%' ORDER BY table_name FOR SHARE",
    );
    const manifest = await handyManifest(tx),
      group = lowestEvidenceKey(first, manifest);
    if (inputs.some((input) => lowestEvidenceKey(input, manifest) !== group))
      throw new Error("Publication must contain one county and year");
    const evidence = await readLowestEvidence(tx, group);
    const existing = await readLowestGroup(
      tx,
      first,
      manifest,
      evidence,
      renewBeforeMs,
    );
    const reads = countyBuildReads(tx);
    const sharedReads = requestReads(reads);
    const cells: {
      input: LowestInput;
      compact: CompactLowest;
      snapshots: string[];
    }[] = [];
    let current = 0;
    let ageIndependent: LowestCell | undefined;
    for (const input of inputs) {
      const key = handyKey(input);
      if (acceptsLowestCell(existing.get(key), input, manifest)) {
        current++;
        continue;
      }
      if (maxCells !== undefined && cells.length >= maxCells) continue;
      const cell = ageIndependent
        ? {
            ...ageIndependent,
            location: { ...ageIndependent.location, age: input.age },
            basis: { ...ageIndependent.basis, age: input.age },
          }
        : await enumerateLowest(reads, input, manifest, sharedReads);
      if (!acceptsLowestCell(cell, input, manifest))
        throw new Error("Invalid lowest premium build");
      // These refusals occur before eligibility and age rating; retain the age in both request views.
      if (
        !cell.provenance.candidates.length &&
        !cell.provenance.excluded.length &&
        ([
          "catalog_not_loaded",
          "metal_level_unknown",
          "zip_limited_service_area",
          "sub_county_rating_area",
          "exchange_offering_unverified",
          "exchange_offering_conflict",
        ].includes(cell.reason ?? "") ||
          (cell.status === "no_plans" &&
            cell.provenance.offered_plan_count === 0))
      )
        ageIndependent = cell;
      const winner = cell.lowest.plan_id;
      const plan = winner
        ? (await sharedReads.countyPlans(input.county!, input.year)).find(
            (p) => p.base_plan_id === winner,
          )
        : undefined;
      const root = evidence.set(String(input.age), cell);
      const compact: CompactLowest = [
        root,
        evidence.reference(winner),
        evidence.reference(plan?.issuer_id ?? null),
        cell.lowest.monthly_cents,
        evidence.reference(input.metal)!,
        evidence.reference(plan?.snapshot_id ?? null),
      ];
      cells.push({
        input,
        compact,
        snapshots: cell.provenance.snapshots.map((snapshot) =>
          String(snapshot.snapshot_id),
        ),
      });
    }
    if (cells.length)
      await publishLowestCells(tx, first, manifest, evidence, cells);
    return {
      status: cells.length ? ("active" as const) : ("current" as const),
      input_manifest: manifest,
      built_cells: cells.length,
      current_cells: current,
    };
  });
}

export async function buildLowestPremiums(db: Database, value: LowestInput) {
  const input = lowestInput({ ...value, page: 1 });
  const location = await resolveLocation(db, input, {
    allowCmsLive: false,
    year: input.year,
  });
  if (location.status !== "available" || !location.county)
    throw new Error("Unresolved county publication");
  return buildLowestCounty(db, [
    countyLowestInput({ ...input, county: location.county }),
  ]);
}

/** Post-load hook rebuilds registered cells; unregistered cells remain unpublished. */
export async function rebuildLowestPremiums(db: Database) {
  if (!loadConfig().lowestPremiums) return;
  for await (const inputs of lowestBuildGroups(db))
    await buildLowestCounty(db, inputs);
}
export async function runLowestBuild(
  args: string[],
  open: () => Database,
  output: { out(message: string): void; error(message: string): void },
) {
  const params: Record<string, string> = {};
  for (let at = 0; at < args.length; at += 2) {
    const key = args[at]?.slice(2);
    if (
      !args[at]?.startsWith("--") ||
      !["year", "age", "zip", "county", "metal", "tobacco"].includes(
        key ?? "",
      ) ||
      params[key!] !== undefined ||
      args[at + 1] === undefined
    ) {
      output.error(
        "Usage: worker build lowest-premiums --year YYYY --age N (--zip ZIP | --county FIPS) [--metal METAL] [--tobacco true|false]",
      );
      return 1;
    }
    params[key!] = args[at + 1]!;
  }
  let db: Database | undefined;
  try {
    const input = lowestQuery(params);
    db = open();
    const result = await buildLowestPremiums(db, input);
    output.out(JSON.stringify(result));
    return ["active", "current"].includes(result.status) ? 0 : 1;
  } catch {
    output.error(
      "Lowest premium build failed; check migrations and loaded source scope",
    );
    return 1;
  } finally {
    await db?.close();
  }
}
