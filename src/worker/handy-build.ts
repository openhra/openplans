import type { Database } from "../db/database.js";
import type { LowestInput } from "../api/handy.js";
import { lowestInput, lowestQuery } from "../api/handy.js";
import { enumerateLowest, isLowestCell } from "../services/handy.js";
import {
  activateLowestCell,
  handyManifest,
  lowestBuildRequests,
  stageLowestCell,
} from "../db/handy-repository.js";
import { loadConfig } from "../config/index.js";

/** Never enumerate a national age/location cube in memory. Build one exact requested cell. */
export async function buildLowestPremiums(db: Database, value: LowestInput) {
  const input = lowestInput({ ...value, page: 1 });
  const staged = await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await tx.query("SELECT pg_advisory_xact_lock(1869636991)");
    const manifest = await handyManifest(tx);
    const cell = await enumerateLowest(tx, input, manifest);
    if (!isLowestCell(cell)) throw new Error("Invalid lowest premium build");
    // Unknown/refused cells stay on the slow path, where missing evidence is rechecked.
    if (!["calculated", "no_plans"].includes(cell.status))
      return { status: "refused" as const, reason: cell.reason };
    const id = await stageLowestCell(tx, input, manifest, JSON.stringify(cell));
    return { status: "staged" as const, id, manifest };
  });
  if (staged.status === "refused") return staged;
  const active = await activateLowestCell(db, staged.id, staged.manifest);
  return {
    status: active ? "active" : "stale",
    build_id: staged.id,
    input_manifest: staged.manifest,
  };
}

/** Post-load hook rebuilds registered cells; absent scopes continue to use full enumeration. */
export async function rebuildLowestPremiums(db: Database) {
  if (!loadConfig().lowestPremiums) return;
  for await (const input of lowestBuildRequests(db))
    await buildLowestPremiums(db, input);
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
      !["year", "age", "zip", "county"].includes(key ?? "") ||
      params[key!] !== undefined ||
      args[at + 1] === undefined
    ) {
      output.error(
        "Usage: worker build lowest-premiums --year YYYY --age N (--zip ZIP | --county FIPS)",
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
    return result.status === "active" ? 0 : 1;
  } catch {
    output.error(
      "Lowest premium build failed; check migrations and loaded source scope",
    );
    return 1;
  } finally {
    await db?.close();
  }
}
