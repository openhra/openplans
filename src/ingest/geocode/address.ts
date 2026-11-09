import { createHash } from "node:crypto";
export interface Address extends Record<string, unknown> {
  source_table?: "npi_address" | "qhp_provider_address";
  source_row?: string;
  npi: string | null;
  kind: string;
  ordinal: number;
  line_1: string | null;
  line_2: string | null;
  city: string | null;
  state: string;
  zip5: string | null;
  snapshot_id: string;
}
const normalize = (value: string | null) =>
  (value ?? "").normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
export function addressIdentity(a: Address) {
  const normalized = JSON.stringify(
    [a.line_1, a.line_2, a.city, a.state, a.zip5].map(normalize),
  );
  return {
    normalized,
    hash: createHash("sha256").update(normalized).digest("hex"),
    row: a.source_row ?? `${a.npi}:${a.kind}:${a.ordinal}`,
  };
}
export function batchCsv(addresses: Address[]): string {
  return (
    addresses
      .map((a, i) =>
        [
          String(i + 1),
          [a.line_1, a.line_2].filter(Boolean).join(" "),
          a.city,
          a.state,
          a.zip5,
        ]
          .map(
            (v) =>
              `"${(v ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, '""')}"`,
          )
          .join(","),
      )
      .join("\n") + "\n"
  );
}
