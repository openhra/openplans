import type { SqlSession } from "../../db/database.js";
import { createRxnormRepository } from "../../ingest/rxnorm/repository.js";

/** Hyphens disambiguate the three FDA 10-digit layouts. Bare codes must already be 11 digits. */
export function normalizeNdc(value: string): string | null {
  if (/^\d{11}$/.test(value)) return value;
  for (const [pattern, widths] of [
    [/^(\d{5})-(\d{4})-(\d{2})$/, [5, 4, 2]],
    [/^(\d{4})-(\d{4})-(\d{2})$/, [5, 4, 2]],
    [/^(\d{5})-(\d{3})-(\d{2})$/, [5, 4, 2]],
    [/^(\d{5})-(\d{4})-(\d{1})$/, [5, 4, 2]],
  ] as const) {
    const match = value.match(pattern);
    if (match)
      return widths
        .map((width, index) => match[index + 1]!.padStart(width, "0"))
        .join("");
  }
  return null;
}

export async function drugConcept(db: SqlSession, rxcui: string) {
  const rx = createRxnormRepository(db),
    concepts = await rx.conceptByRxcui(rxcui);
  if (!concepts.length) return null;
  const snapshot = concepts[0]!.snapshot_id;
  const [ingredients, ndcs, links] = await Promise.all([
    rx.ingredientsOf(rxcui),
    rx.ndcsForRxcui(rxcui),
    db.query(
      `SELECT DISTINCT r.source_rxcui,r.target_rxcui,r.rela,c.rxcui,c.name,c.tty,c.snapshot_id
      FROM rx_relation r JOIN rx_concept c ON c.snapshot_id=r.snapshot_id
      AND c.rxcui=CASE WHEN r.source_rxcui=$1 THEN r.target_rxcui ELSE r.source_rxcui END
      WHERE r.snapshot_id=$2 AND (r.source_rxcui=$1 OR r.target_rxcui=$1)
      AND r.rela IN ('tradename_of','has_tradename') AND r.suppress IN ('','N') AND c.suppress='N'
      ORDER BY r.source_rxcui,r.target_rxcui,r.rela,c.rxcui,c.tty,c.name`,
      [rxcui, snapshot],
    ),
  ]);
  return {
    rxcui,
    concepts,
    ingredients,
    brand_generic_links: links.rows,
    ndcs,
    snapshot_id: snapshot,
    resolution: concepts.some((c) => c.suppress === "N")
      ? "active"
      : "suppressed",
    patient_price: null,
  };
}
