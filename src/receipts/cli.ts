#!/usr/bin/env node
import { currentEnvironment } from "../config/index.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createDatabase } from "../db/database.js";
import type { Database } from "../db/database.js";
import { replayExport, restoredFilesSchema } from "./replay.js";

/** The connection is explicit and local; ordinary verification never opens a database. */
export function localReplayUrl(value: string | undefined): string {
  if (!value) throw new Error("restored_database_required");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.search
  )
    throw new Error("restored_database_must_be_local");
  return value;
}

export async function receiptCli(
  args: string[],
  env: NodeJS.ProcessEnv = currentEnvironment(),
  out: (line: string) => void = console.log,
): Promise<number> {
  let db: Database | undefined;
  try {
    const [receiptPath, ...flags] = args;
    if (!receiptPath) throw new Error("usage");
    let inputPath: string | undefined;
    let filesPath: string | undefined;
    let replay = false;
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (flag === "--replay" && !replay) replay = true;
      else if (flag === "--inputs" && !inputPath && flags[i + 1])
        inputPath = flags[++i];
      else if (flag === "--snapshots" && !filesPath && flags[i + 1])
        filesPath = flags[++i];
      else throw new Error("usage");
    }
    const json = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(path, "utf8"));
    const receipt = await json(receiptPath);
    const input = inputPath ? await json(inputPath) : undefined;
    const files = filesPath
      ? restoredFilesSchema.parse(await json(filesPath))
      : {};
    if (replay)
      db = createDatabase(localReplayUrl(env.OPENPLANS_REPLAY_DATABASE_URL));
    const result = await replayExport(receipt, input, files, db);
    out(JSON.stringify(result));
    if (result.status === "verified") return 0;
    return result.status === "failed" ? 1 : 2;
  } catch {
    out(
      JSON.stringify({
        status: "unavailable",
        reason: "receipt_files_or_local_database_required",
        usage:
          "openplans-receipt RECEIPT [--inputs INPUTS] [--snapshots FILE_MAP] [--replay]",
      }),
    );
    return 2;
  } finally {
    await db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await receiptCli(process.argv.slice(2));
