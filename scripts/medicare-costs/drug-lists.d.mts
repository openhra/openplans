export const drugListsFile: string;
export const SELECTED_COLUMNS: string[];
export interface SelectedEntry {
  ndc11: string;
  drug: string;
  ipay: number;
  rows: number[];
}
export function parseCsv(source: string): string[][];
export function usDate(value: string | undefined): string | null;
export function buildSelectedLists(
  csv: string,
  years?: string[],
): Record<string, { listed: SelectedEntry[]; partial: SelectedEntry[] }>;
export function drugListErrors(
  lists: unknown,
  otherManifests?: unknown[],
): string[];
export function selectedCsv(lists: unknown, dataDir: string): Promise<string>;
export function drugListCacheErrors(
  lists: unknown,
  dataDir: string,
): Promise<string[]>;
