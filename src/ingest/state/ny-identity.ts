import { readFile } from "node:fs/promises";
import type { StateCatalogRow } from "./catalog.js";

export interface NyIdentityPublication {
  rate_url: string;
  rate_sha256: string;
  url: string;
  sha256: string;
  member: string;
  headers: Record<string, string>;
  rows: { source_row: number; cells: Record<string, string> }[];
}
const document = JSON.parse(
  await readFile(
    new URL(
      "../../../data/rating-rules/ny-plan-identities-2026.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  schema_version: string;
  plan_year: number;
  publications: NyIdentityPublication[];
};
if (
  document.schema_version !== "ny-plan-identities-v1" ||
  document.plan_year !== 2026
)
  throw new Error("Invalid NY identity source cut");

/** Exact current variant identity, explicit metal and 2026 regional price cells.
 * An Off cell can exclude a plan; On cells never replace CMS Exchange evidence. */
export function nyFiledIdentity(
  row: StateCatalogRow,
  publications = document.publications,
) {
  if (row.state !== "NY" || row.plan_year !== 2026) return null;
  const publication = publications.find(
    (p) =>
      p.rate_url === row.rate.provenance.sourceUrl &&
      p.rate_sha256 === row.rate.provenance.sourceSha256,
  );
  const region = /^Rating Area ([1-8])$/.exec(row.region)?.[1];
  const id = row.raw_record.plan_id;
  if (!publication || !region || !id || !/^\d{5}NY\d{7}$/.test(id)) return null;
  const column = 69 + Number(region);
  if (
    publication.headers["3"] !== "4. Market" ||
    publication.headers["4"] !== "5. Current HIOS ID (16 Digits)" ||
    publication.headers["6"] !== "7. Metal Level or Catastrophic" ||
    publication.headers["7"] !== "8. Exchange / CSR Type" ||
    !publication.headers[String(column)]?.startsWith(
      `Region ${region} - 2026 Rate (`,
    )
  )
    return null;
  const matches = publication.rows.filter((r) =>
    new RegExp(`^${id}\\d{2}$`).test(r.cells["4"] ?? ""),
  );
  if (
    !matches.length ||
    matches.some(
      (r) =>
        r.cells["3"] !== "Individual" ||
        !["Yes", "No"].includes(r.cells["16"] ?? "") ||
        !Number.isSafeInteger(r.source_row) ||
        r.source_row < 4,
    )
  )
    return null;
  const metals = new Set(matches.map((r) => r.cells["6"]));
  const metal = [...metals][0];
  if (
    metals.size !== 1 ||
    !metal ||
    !["Bronze", "Silver", "Gold", "Platinum", "Catastrophic"].includes(metal)
  )
    return null;
  const prices = matches.filter((r) => {
    const cell = r.cells[String(column)];
    if (!cell || !/^\d+(?:\.\d+)?$/.test(cell)) return false;
    // Exhibit cells can contain cached Excel floating-point tails.
    const cents = Math.round(Number(cell) * 100);
    return (
      cents > 0 &&
      Number.isSafeInteger(cents) &&
      cents === row.rate.prices.single
    );
  });
  if (!prices.length) return null;
  return {
    source: "ny_dfs_exhibit_23" as const,
    evidence: "filed_plan_identity" as const,
    metal,
    off_exchange: matches.every(
      (r) => r.cells["7"] === "Off" && r.cells["4"]?.endsWith("00"),
    ),
    source_url: publication.url,
    source_sha256: publication.sha256,
    member: publication.member,
    sheet: "23",
    source_rows: matches.map((r) => r.source_row),
    price_rows: prices.map((r) => r.source_row),
    columns: {
      current_hios_id: "E",
      metal: "G",
      exchange_csr_type: "H",
      region_price: `B${String.fromCharCode(65 + column - 52)}`,
    },
    cells: matches.map((r) => ({
      source_row: r.source_row,
      current_hios_id: r.cells["4"],
      metal: r.cells["6"],
      exchange_csr_type: r.cells["7"],
      region_price: r.cells[String(column)],
    })),
  };
}
