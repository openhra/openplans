import { readFile } from "node:fs/promises";
import type { Database } from "../db/database.js";
import { admitAnnualData } from "../db/data-window.js";
import type { WorkerOutput } from "./commands.js";

export const dataAdmissionUsage =
  "Usage: worker data-admission --manifest FILE";

export async function runDataAdmission(
  args: string[],
  open: () => Database,
  output: WorkerOutput,
): Promise<number> {
  if (args.length !== 2 || args[0] !== "--manifest" || !args[1]) {
    output.error(dataAdmissionUsage);
    return 1;
  }
  let db: Database | undefined;
  try {
    const input: unknown = JSON.parse(await readFile(args[1], "utf8"));
    if (!Array.isArray(input) || !input.length)
      throw new Error("empty admission manifest");
    db = open();
    const admitted = await admitAnnualData(db, input);
    output.out(
      JSON.stringify({
        admitted: admitted.map(({ domain, coverage_year }) => ({
          domain,
          coverage_year,
        })),
      }),
    );
    return 0;
  } catch {
    output.error(
      "worker data-admission refused; supply a reviewed manifest matching ACTIVE release receipts and their coverage years",
    );
    return 1;
  } finally {
    await db?.close();
  }
}
