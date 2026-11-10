export interface PartDReading {
  rows: Record<string, number>;
  groups: Record<string, Record<string, [number, string]>>;
  plans: Record<string, { formularies: string[]; suppressed: boolean }>;
  sample: {
    plan_key: string;
    rxcui: string;
    status: string;
    formulary_id: string | null;
    packages: unknown[][];
    tier_cost_sharing: unknown[][];
  }[];
}
export interface PartDReference extends PartDReading {
  headers: Record<string, string[]>;
  suppressed_sample: string[];
}
export interface PartDActual extends PartDReading {
  suppressed: Record<string, string | null>;
}
export function digest(lines: Iterable<string>): string;
export function readActual(
  db: {
    query(
      sql: string,
      parameters?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  },
  snapshotId: string,
  expected: PartDReference,
  drug: (planKey: string, rxcui: string) => Promise<Record<string, unknown>>,
): Promise<PartDActual>;
export function compare(
  expected: PartDReference,
  actual: PartDActual,
): string[];
export const mutants: Record<string, (actual: PartDActual) => void>;
export function negativeControls(
  expected: PartDReference,
  actual: PartDActual,
): Record<string, boolean>;
