/** Shared limits and ordinal rules for request-scoped employee census rows. */
export const MAX_CENSUS_ROWS = 25;

export interface CensusRow<T = unknown> {
  ordinal: number;
  value: T;
}

export class CensusRowsError extends Error {
  readonly code = "invalid_batch";
  constructor() {
    super("invalid_batch");
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate the batch envelope and assign local, one-based row ordinals. */
export function censusRows(value: unknown): CensusRow[] {
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "rows") ||
    !Array.isArray(value.rows) ||
    value.rows.length < 1 ||
    value.rows.length > MAX_CENSUS_ROWS
  )
    throw new CensusRowsError();
  return value.rows.map((row: unknown, index) => ({
    ordinal: index + 1,
    value: row,
  }));
}

/** Require all supplied ordinals to be exactly 1..N in request order. */
export function sequentialCensusOrdinals(rows: readonly number[]): boolean {
  return (
    rows.length >= 1 &&
    rows.length <= MAX_CENSUS_ROWS &&
    rows.every((row, index) => row === index + 1)
  );
}
