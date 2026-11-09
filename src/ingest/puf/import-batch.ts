import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../../db/database.js";
import {
  cachedImportFiles,
  importDataDirectory,
  importRows,
  verifyImportFile,
} from "./import-source.js";
import type { ImportFile } from "./import-source.js";
import { validateImportHeader } from "./import-parse.js";
import { importPufs } from "./import.js";
import type { PufImportReport } from "./import.js";

/** Discover HealthCare.gov individual medical states from the publication, not a static exchange list. */
export async function pufStates(
  files: ImportFile[],
  year: number,
): Promise<string[]> {
  const file = files.find((file) => file.kind === "plan-attributes");
  if (!file) throw new Error("Plan attributes required for state discovery");
  await verifyImportFile(file);
  const states = new Set<string>();
  for await (const row of importRows(file)) {
    validateImportHeader(file.kind, row.values, year);
    const r = row.values;
    if (
      r.MarketCoverage === "Individual" &&
      r.DentalOnlyPlan === "No" &&
      r.QHPNonQHPTypeId !== "Off the Exchange"
    ) {
      if (!/^[A-Z]{2}$/.test(r.StateCode ?? ""))
        throw new Error("Invalid publication state");
      states.add(r.StateCode!);
    }
  }
  if (!states.size)
    throw new Error("No individual medical states in publication");
  return [...states].sort();
}

/** Temporary bounded state partitions preserve the archive hash and original physical source row. */
export async function partitionPufs(
  files: ImportFile[],
  states: string[],
  year: number,
  dataDir: string,
) {
  const root = join(dataDir, "work");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, `puf-${year}-`));
  const result = new Map(states.map((state) => [state, [] as ImportFile[]]));
  try {
    for (const file of files) {
      await verifyImportFile(file);
      const buffers = new Map(states.map((state) => [state, ""])),
        counts = new Map(states.map((state) => [state, 0]));
      const paths = new Map(
        states.map((state) => [
          state,
          join(directory, `${state}-${file.kind}.jsonl`),
        ]),
      );
      for (const path of paths.values()) await writeFile(path, "");
      for await (const row of importRows(file)) {
        validateImportHeader(file.kind, row.values, year);
        const state = row.values.StateCode!;
        if (!buffers.has(state)) continue;
        counts.set(state, counts.get(state)! + 1);
        buffers.set(state, buffers.get(state)! + JSON.stringify(row) + "\n");
        if (buffers.get(state)!.length >= 256 * 1024) {
          await appendFile(paths.get(state)!, buffers.get(state)!);
          buffers.set(state, "");
        }
      }
      for (const state of states) {
        const path = paths.get(state)!;
        await appendFile(path, buffers.get(state)!);
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(path)) {
          hash.update(chunk);
          bytes += chunk.length;
        }
        result.get(state)!.push({
          ...file,
          rowCache: {
            path,
            sha256: hash.digest("hex"),
            bytes,
            count: counts.get(state)!,
          },
        });
      }
    }
    return {
      states: result,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export interface StateImportResult {
  state: string;
  year: number;
  status: "ACTIVE" | "QUARANTINED" | "FAILED";
  report?: PufImportReport;
  error?: string;
}
export async function importAllStates(
  db: Database,
  options: {
    year: number;
    dataDir?: string;
    files?: ImportFile[];
    onState?: (result: StateImportResult) => void | Promise<void>;
  },
) {
  const dataDir = options.dataDir ?? importDataDirectory();
  const acquired = options.files
    ? { files: options.files, manifestPath: null }
    : await cachedImportFiles(dataDir, options.year);
  const states = await pufStates(acquired.files, options.year);
  const partitions = await partitionPufs(
    acquired.files,
    states,
    options.year,
    dataDir,
  );
  const results: StateImportResult[] = [];
  try {
    for (const state of states) {
      let result: StateImportResult;
      try {
        const report = await importPufs(db, {
          year: options.year,
          state,
          dataDir,
          files: partitions.states.get(state),
          manifestPath: acquired.manifestPath,
        });
        result = { state, year: options.year, status: report.status, report };
      } catch {
        result = {
          state,
          year: options.year,
          status: "FAILED",
          error:
            "State import failed; inspect state snapshots and quality issues",
        };
      }
      results.push(result);
      const path = join(
        dataDir,
        "reports",
        `puf-${options.year}-all-states.json`,
      );
      await mkdir(join(dataDir, "reports"), { recursive: true });
      const temporary = `${path}.${randomUUID()}.part`;
      await writeFile(
        temporary,
        JSON.stringify(
          {
            year: options.year,
            manifest_path: acquired.manifestPath,
            states,
            results,
          },
          null,
          2,
        ) + "\n",
      );
      await rename(temporary, path);
      await options.onState?.(result);
    }
  } finally {
    await partitions.cleanup();
  }
  return {
    year: options.year,
    passed: results.every((result) => result.status === "ACTIVE"),
    results,
  };
}
