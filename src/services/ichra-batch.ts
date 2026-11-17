import type { SqlSession } from "../db/database.js";
import { boundedDatabase } from "../db/bounded.js";
import { dataGeneration } from "../api/cache/generation.js";
import { InputError, ichraRequest } from "../api/validation.js";
import { ichraAffordability } from "./ichra.js";
import type { IchraRequest } from "./ichra.js";
import { requestReads } from "./request-reads.js";
import {
  censusRows as sharedCensusRows,
  MAX_CENSUS_ROWS,
  type CensusRow,
} from "@openplans/plugin-sdk";

export { MAX_CENSUS_ROWS };
export const MAX_CENSUS_RESPONSE_BYTES = 1_048_576;
export class CensusError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type IchraResult = Awaited<ReturnType<typeof ichraAffordability>>;
/** Read-only calculation access. The host owns the lifetime of the public read session. */
export interface IchraCalculationHost {
  affordability(request: IchraRequest): Promise<IchraResult>;
}
export type { CensusRow };
export type CensusRowResult = {
  row: number;
  class_basis: "operator";
} & (
  | { status: "calculated" | "unknown"; result: IchraResult }
  | { status: "invalid"; error: { code: string; field: string } }
);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function censusRows(value: unknown): CensusRow[] {
  try {
    return sharedCensusRows(value);
  } catch {
    throw new CensusError("INVALID_BATCH");
  }
}

function employeeRow(value: unknown, ordinal: number): IchraRequest {
  if (!object(value) || value.row !== ordinal) throw new InputError("row");
  if (
    Object.keys(value).some(
      (key) => !["row", "input", "class_ref"].includes(key),
    )
  )
    throw new InputError("row", "UNKNOWN_FIELD");
  if (
    value.class_ref !== undefined &&
    (typeof value.class_ref !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value.class_ref))
  )
    throw new InputError("class_ref");
  return ichraRequest(value.input);
}

function invalid(error: InputError) {
  // Unknown keys themselves can contain personal data, including dots or line breaks.
  return {
    code: error.code,
    field: error.code === "UNKNOWN_FIELD" ? "input" : error.field,
  };
}

async function calculateRows(
  host: IchraCalculationHost,
  rows: CensusRow[],
  signal: AbortSignal,
) {
  const results: CensusRowResult[] = [];
  for (const row of rows) {
    signal.throwIfAborted();
    const base = { row: row.ordinal, class_basis: "operator" as const };
    try {
      const result = await host.affordability(
        employeeRow(row.value, row.ordinal),
      );
      results.push({
        ...base,
        status: result.status === "calculated" ? "calculated" : "unknown",
        result,
      });
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      results.push({ ...base, status: "invalid", error: invalid(error) });
    }
  }
  signal.throwIfAborted();
  return results;
}

/** No answer, body hash or employee lookup escapes this request's scope. */
export async function ichraAffordabilityBatch(
  db: SqlSession,
  rows: CensusRow[],
  signal: AbortSignal,
) {
  if (rows.length < 1 || rows.length > MAX_CENSUS_ROWS)
    throw new CensusError("INVALID_BATCH");
  const read = async (session: SqlSession) => {
    const bounded = boundedDatabase(session, signal);
    const generation = await dataGeneration(bounded);
    const reads = requestReads(bounded);
    const host: IchraCalculationHost = {
      affordability: (request) =>
        ichraAffordability(bounded, request, { reads, allowCmsLive: false }),
    };
    const results = await calculateRows(host, rows, signal);
    const counts = {
      submitted: rows.length,
      calculated: 0,
      unknown: 0,
      invalid: 0,
    };
    for (const row of results) counts[row.status]++;
    const response = {
      status: "complete" as const,
      selection_universe: "public" as const,
      rows: results,
      counts,
      provenance: { generation, input_basis: "operator" as const },
      retention: "request_memory_only" as const,
    };
    if (Buffer.byteLength(JSON.stringify(response)) > MAX_CENSUS_RESPONSE_BYTES)
      throw new CensusError("BATCH_RESPONSE_TOO_LARGE");
    return response;
  };
  if (db.withRequest) {
    return db.withRequest(signal, async (session) => {
      // Before the first data read. Every row and its generation use this snapshot.
      await session.exec(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return read(session);
    });
  }
  // Providers without transaction scopes must prove stability. Never return mixed generations.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await read(db);
    if (
      result.provenance.generation ===
      (await dataGeneration(boundedDatabase(db, signal)))
    )
      return result;
  }
  throw new CensusError("GENERATION_CHANGED");
}
