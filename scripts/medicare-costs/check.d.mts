export const documentsFile: string;
export const parametersFile: string;
export const oraclesFile: string;
export const YEARS: string[];
export const PARAMETERS: string[];
export function documentErrors(manifest: unknown): string[];
export function parameterErrors(
  parameters: unknown,
  manifest: unknown,
): string[];
export function oracleErrors(
  parameters: unknown,
  oracles: unknown,
  manifest: unknown,
): string[];
export function dollarsToCents(cell: string | undefined): number | null;
export function pinErrors(
  manifest: {
    cacheSource: string;
    documents: { id: string; sha256: string; bytes: number; url: string }[];
  },
  dataDir: string,
): Promise<string[]>;
export function readJson(file: string): Promise<unknown>;
export const pbpDocumentsFile: string;
export const boundsFile: string;
export function memberErrors(manifest: unknown): string[];
export function crossManifestErrors(manifests: unknown[]): string[];
export function boundErrors(bounds: unknown, manifests: unknown[]): string[];
export function zipMember(bytes: Buffer, name: string): Buffer | null;
export function memberPinErrors(
  manifest: {
    cacheSource: string;
    documents: {
      id: string;
      sha256: string;
      members?: { name: string; sha256: string; bytes: number }[];
    }[];
  },
  dataDir: string,
): Promise<string[]>;
