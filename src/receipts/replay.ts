import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqlSession } from "../db/database.js";
import {
  censusRows,
  ichraAffordabilityBatch,
} from "../services/ichra-batch.js";
import { receiptDependencies, receiptIdentity } from "./ichra.js";
import { receiptSchema, verifyReceipt } from "./evidence.js";

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path))
    hash.update(bytes as Buffer);
  return hash.digest("hex");
}
export const restoredFilesSchema = z.record(z.string(), z.string().min(1));

/** Reads only explicit local files and an optional operator-restored database. Never imports or downloads. */
export async function replayExport(
  value: unknown,
  input: unknown,
  files: Record<string, string>,
  db?: SqlSession,
) {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success)
    return { status: "failed" as const, reason: "invalid_receipt" };
  const receipt = parsed.data;
  const signal = AbortSignal.timeout(15_000);
  try {
    const dependencies = db
      ? await receiptDependencies(db)
      : {
          ...receipt.provenance,
          ...(await receiptIdentity()),
        };
    return await verifyReceipt(receipt, {
      input,
      dependencies,
      snapshotHash: async (id) => {
        const path = Object.hasOwn(files, id) ? files[id] : undefined;
        if (!path) return undefined;
        try {
          return await fileSha256(path);
        } catch {
          return undefined;
        }
      },
      ...(db && {
        replay: (input: unknown) =>
          ichraAffordabilityBatch(db, censusRows(input), signal),
      }),
    });
  } catch {
    return {
      status: "unavailable" as const,
      reason: "restored_database_unavailable",
    };
  }
}
