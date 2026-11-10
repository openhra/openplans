import type { IncomeMeasure } from "../../../src/domain/ichra/index.js";

export interface CaseInput {
  planStart: string;
  dob: string;
  residence: string;
  worksite?: string;
  remote?: boolean;
  monthsAvailable?: number;
  hraAnnualCents: number;
  income: IncomeMeasure;
  safeHarbors?: {
    location?: boolean;
    lookBack?: boolean;
    lowestAgeBand?: boolean;
  };
}
export interface HandCase {
  id: string;
  input: CaseInput;
  hand: string;
  expect: Record<string, unknown>;
  kills?: string[];
}
export const HARRIS: string;
export const TRAVIS: string;
export const LCSP: Record<string, number>;
export const CASES: HandCase[];
export function evaluateCase(
  input: CaseInput,
  m: object,
): Record<string, unknown>;
export function matches(
  result: Record<string, unknown>,
  expect: Record<string, unknown>,
): boolean;
