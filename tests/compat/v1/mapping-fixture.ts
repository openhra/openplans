import { readFile } from "node:fs/promises";
import type { ImportKind } from "../../../src/ingest/puf/import-source.js";

export interface PublicRowCut {
  source_row: number;
  values: Record<string, string>;
}
interface PublicSourceCut {
  kind: ImportKind;
  base: string;
  url: string;
  sha256: string;
  rows: PublicRowCut[];
}
export const mappingFixture = JSON.parse(
  await readFile(new URL("./mapping-public.json", import.meta.url), "utf8"),
) as { sources: PublicSourceCut[] };
