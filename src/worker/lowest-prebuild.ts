import { planAnnualWork } from "../ingest/data-window.js";
import { annualRows, servingPolicy } from "../services/data-window.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { lowestInput } from "../api/handy.js";
import type { LowestInput } from "../api/handy.js";
import {
  resolveLocation,
  relationshipInventoryCounties,
} from "../api/repository.js";
import { canonical } from "../api/cache/index.js";
import type { Database } from "../db/database.js";
import {
  handyManifest,
  lowestInventoryLocations,
  lowestBuildSize,
  lowestPublishedCells,
  digest,
  handyKey,
  LOWEST_PUBLICATION_ALGORITHM,
  countyLowestInput,
} from "../db/handy-repository.js";
import { acceptsLowestCell } from "../services/handy.js";
import { buildLowestCounty } from "./handy-build.js";

export const lowestPrebuildUsage =
  "Usage: worker prebuild lowest-premiums [--years YYYY,YYYY] [--inventory FILE] [--max-cells N] [--dry-run] | --renew [--max-groups N] [--max-seconds N]";

/** Stream the cube; retain locations only, never every age/year cell. */
export async function* lowestInventory(
  db: Database,
  options: { years?: number[]; inventory?: unknown[] } = {},
): AsyncGenerator<LowestInput> {
  if (options.inventory) {
    const entries = new Map<string, LowestInput>();
    let allowed: Set<number> | null | undefined;
    for (const value of options.inventory) {
      let input = lowestInput(value);
      if (allowed === undefined) {
        const policy = await servingPolicy(db);
        allowed =
          policy.history_years === "all"
            ? null
            : new Set(policy.domains.individual.allowed_years);
      }
      if (allowed && !allowed.has(input.year)) continue;
      const location = await resolveLocation(db, input, {
        allowCmsLive: false,
        year: input.year,
      });
      if (location.status !== "available" || !location.county)
        throw new Error("Inventory location must resolve to one county");
      if (input.metal !== "silver" || input.tobacco || input.page !== 1)
        throw new Error(
          "Inventory must contain non-tobacco Silver cells at page 1",
        );
      if (options.years && !options.years.includes(input.year))
        throw new Error("Inventory year outside served years");
      input = countyLowestInput({ ...input, county: location.county });
      entries.set(canonical(input), input);
    }
    const sorted = [...entries.values()].sort((a, b) => {
      const left = canonical({ ...a, age: 0 }),
        right = canonical({ ...b, age: 0 });
      if (left < right) return -1;
      if (left > right) return 1;
      return a.age - b.age;
    });
    for (const input of sorted) yield input;
    return;
  }
  const { scopes, counties: loaded } = await lowestInventoryLocations(db);
  const counties = [
    ...new Set([...loaded, ...(await relationshipInventoryCounties(db))]),
  ].sort();
  const years = await annualRows(
    db,
    options.years ?? [...new Set(scopes.map((s) => s.year))],
    (year) => year,
  );
  if (
    !years.length ||
    years.some((year) => !scopes.some((s) => s.year === year))
  )
    throw new Error("Served year has no loaded catalog");
  for (const year of [...years].sort((a, b) => a - b)) {
    for (const county of counties)
      for (let age = 0; age <= 64; age++)
        yield lowestInput({ county, year, age });
  }
}

export async function prebuildLowestPremiums(
  db: Database,
  options: {
    years?: number[];
    inventory?: unknown[];
    maxCells?: number;
    dryRun?: boolean;
    progress?: (value: Record<string, unknown>) => void;
  } = {},
) {
  const started = performance.now();
  const manifest = await handyManifest(db);
  const inventoryHash = createHash("sha256");
  let expected = 0;
  for await (const input of lowestInventory(db, options)) {
    inventoryHash.update(canonical(input) + "\n");
    expected++;
  }
  if (!expected) throw new Error("Empty lowest premium inventory");
  const inventoryDigest = inventoryHash.digest("hex");
  let built = 0,
    current = 0;
  if (!options.dryRun) {
    let pending: LowestInput[] = [];
    const flush = async () => {
      if (
        !pending.length ||
        (options.maxCells !== undefined && built >= options.maxCells)
      )
        return;
      const result = await buildLowestCounty(
        db,
        pending,
        options.maxCells === undefined ? undefined : options.maxCells - built,
      );
      if (result.input_manifest !== manifest)
        throw new Error(
          "Pricing sources changed during prebuild; rerun to resume",
        );
      built += result.built_cells;
      current += result.current_cells;
      options.progress?.({
        built,
        current,
        expected_cells: expected,
        county: pending[0]!.county,
        year: pending[0]!.year,
      });
    };
    for await (const input of lowestInventory(db, options)) {
      if (
        pending.length &&
        canonical({ ...pending[0], age: 0 }) !== canonical({ ...input, age: 0 })
      ) {
        await flush();
        pending = [];
        if (options.maxCells !== undefined && built >= options.maxCells) break;
      }
      pending.push(input);
    }
    await flush();
  }
  // Audit shared evidence once per county and retain only cell hashes.
  const published = new Map<string, { hash: string; expiresAt: number }>();
  if (!options.dryRun)
    for await (const cell of lowestPublishedCells(db, manifest)) {
      let input: LowestInput;
      try {
        input = lowestInput(JSON.parse(cell.request_json));
      } catch {
        continue;
      }
      if (
        cell.request_key === handyKey(input) &&
        cell.request_json === canonical(input) &&
        acceptsLowestCell(cell.payload, input, manifest)
      )
        published.set(cell.request_key, {
          hash: digest(canonical(cell.payload)),
          expiresAt: cell.expiresAt,
        });
    }
  const payloadHash = createHash("sha256").update(
    LOWEST_PUBLICATION_ALGORITHM +
      "\n" +
      manifest +
      "\n" +
      inventoryDigest +
      "\n",
  );
  let ready = 0;
  const expirations: number[] = [];
  if (!options.dryRun)
    for await (const input of lowestInventory(db, options)) {
      const request = canonical(input),
        cell = published.get(handyKey(input));
      if (cell) {
        ready++;
        expirations.push(cell.expiresAt);
        payloadHash.update(request + "\n" + cell.hash + "\n");
      }
    }
  const sizes = await lowestBuildSize(db);
  ready -= expirations.filter((expiry) => expiry <= sizes.checked_at_ms).length;
  if ((await handyManifest(db)) !== manifest)
    throw new Error("Pricing sources changed during prebuild; rerun to resume");
  const complete = ready === expected;
  let status = "partial";
  if (options.dryRun) status = "planned";
  else if (complete) status = "complete";
  return {
    status,
    input_manifest: manifest,
    publication_algorithm: LOWEST_PUBLICATION_ALGORITHM,
    inventory_sha256: inventoryDigest,
    expected_cells: expected,
    ready_cells: ready,
    missing_cells: expected - ready,
    built_cells: built,
    current_cells: current,
    digest: complete ? payloadHash.digest("hex") : null,
    ...sizes,
    wall_ms: Math.round(performance.now() - started),
  };
}

export async function runLowestPrebuild(
  args: string[],
  open: () => Database,
  output: { out(message: string): void; error(message: string): void },
) {
  let db: Database | undefined;
  try {
    const params = new Map<string, string>();
    let dryRun = false;
    for (let at = 0; at < args.length; at++) {
      const key = args[at]!;
      if (key === "--dry-run" && !dryRun) {
        dryRun = true;
        continue;
      }
      if (
        !["--years", "--inventory", "--max-cells"].includes(key) ||
        params.has(key) ||
        !args[at + 1] ||
        args[at + 1]!.startsWith("--")
      )
        throw new Error("Invalid arguments");
      params.set(key, args[++at]!);
    }
    const yearsText = params.get("--years");
    if (yearsText && !/^\d{4}(,\d{4})*$/.test(yearsText))
      throw new Error("Invalid years");
    let years = yearsText?.split(",").map(Number);
    if (
      years?.some((year) => year < 2014) ||
      (years && new Set(years).size !== years.length)
    )
      throw new Error("Invalid years");
    const maxText = params.get("--max-cells");
    if (
      maxText &&
      (!/^[1-9]\d*$/.test(maxText) || !Number.isSafeInteger(Number(maxText)))
    )
      throw new Error("Invalid cell limit");
    if (years) {
      const work = planAnnualWork("lowest-premiums", years);
      if (work.skipped.length) {
        output.out(JSON.stringify({ skipped: work.skipped }));
        years = work.years;
        if (!years.length) return 0;
      }
    }
    let inventory: unknown[] | undefined;
    if (params.has("--inventory")) {
      const value: unknown = JSON.parse(
        await readFile(params.get("--inventory")!, "utf8"),
      );
      if (!Array.isArray(value) || !value.length || value.length > 100_000)
        throw new Error(
          "Inventory must be a nonempty JSON array with at most 100000 cells",
        );
      inventory = value;
    }
    db = open();
    const result = await prebuildLowestPremiums(db, {
      years,
      inventory,
      dryRun,
      maxCells: maxText ? Number(maxText) : undefined,
      progress: (value) => output.error(JSON.stringify(value)),
    });
    output.out(JSON.stringify(result));
    return result.status === "partial" ? 2 : 0;
  } catch {
    output.error(lowestPrebuildUsage);
    output.error(
      "Prebuild incomplete; check inventory, loaded sources, expiry and disk budget, then rerun to resume",
    );
    return 1;
  } finally {
    await db?.close();
  }
}
