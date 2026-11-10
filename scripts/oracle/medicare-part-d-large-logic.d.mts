import type { SqlSession } from "../../src/db/database.js";
export interface LargeReading {
  rows: Record<string, number>;
  groups: Record<string, Record<string, [number, string]>>;
  plans: string[];
  pharmacy_sample: {
    plan_key: string;
    zip: string;
    status: string;
    pharmacies: (string | boolean)[][];
  }[];
  price_sample: {
    plan_key: string;
    rxcui: string;
    status: string;
    rows: (string | number)[][];
    reason?: string;
  }[];
}
export interface LargeReference extends LargeReading {
  headers: Record<string, string[]>;
  raw_rows: Record<string, number>;
  sample_modulus: number;
}
export function rowAccumulator(): {
  add(line: string): void;
  result(): [number, string];
};
export function readLargeActual(
  db: SqlSession,
  snapshotId: string,
  expected: LargeReference,
  pharmacy: (key: string, zip: string) => Promise<Record<string, unknown>>,
  drug: (key: string, rxcui: string) => Promise<Record<string, unknown>>,
): Promise<LargeReading>;
export function compareLarge(
  expected: LargeReading,
  actual: LargeReading,
): string[];
export function largeNegativeControls(
  expected: LargeReading,
  actual: LargeReading,
): Record<string, boolean>;
