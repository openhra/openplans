/**
 * Link-outs: pages a person can open themselves when the loaded data leaves an answer `unknown`.
 * OpenPlans never fetches them and draws no conclusion from them. They come from cells already
 * read for the answer (the plan's published attribute and network rows) or from the identity
 * asked about, so serving them costs no extra query.
 */

export type LinkOutRel =
  | "provider_directory"
  | "formulary"
  | "summary_of_benefits"
  | "plan_brochure"
  | "npi_registry"
  | "medicare_plan_finder";

export interface LinkOut {
  kind: "link_out";
  rel: LinkOutRel;
  url: string;
  /** Where the URL came from: a published catalog cell, or a public page built from the identity. */
  source:
    "plan_attributes" | "network" | "npi_registry" | "medicare_plan_finder";
  /** The catalog snapshot and row that published the URL; null for a page built from an identity. */
  snapshot_id: string | null;
  source_row: number | null;
}

/** The answer families that carry link-outs; `data-availability` reports one flag per family. */
export const LINK_OUT_FAMILIES = ["provider", "drug", "benefits"] as const;
export type LinkOutFamily = (typeof LINK_OUT_FAMILIES)[number];

const FAMILY_RELS: Record<LinkOutFamily, readonly LinkOutRel[]> = {
  provider: ["provider_directory"],
  drug: ["formulary"],
  benefits: ["summary_of_benefits", "plan_brochure"],
};

/** Plan-attribute cells that publish a page, by the rel each one serves. */
const ATTRIBUTE_URL_COLUMNS = {
  formulary: "FormularyURL",
  summary_of_benefits: "URLForSummaryofBenefitsCoverage",
  plan_brochure: "PlanBrochure",
} as const satisfies Partial<Record<LinkOutRel, string>>;

const NPI_REGISTRY_PAGE = "https://npiregistry.cms.hhs.gov/provider-view/";
const MEDICARE_PLAN_FINDER_PAGE =
  "https://www.medicare.gov/plan-compare/#/plan-details/";
const ACTIVE = "ACTIVE";

/**
 * The shape of a servable URL: http(s), a host with no credentials, no whitespace.
 */
const PUBLISHED_URL_PATTERN = "^https?://[^\\s/?#@]+([/?#]\\S*)?$";
const PUBLISHED_URL = new RegExp(PUBLISHED_URL_PATTERN, "i");
/** `cell` is a SQL text expression; true when it holds a servable URL. */
const sqlPublishedUrl = (cell: string) =>
  `(btrim(${cell}) ~* '${PUBLISHED_URL_PATTERN}')`;

/** A published cell as a link: http(s) only, no credentials, trimmed; anything else is no link. */
export function publishedUrl(value: unknown): string | null {
  if (typeof value !== "string" || !PUBLISHED_URL.test(value.trim()))
    return null;
  try {
    const parsed = new URL(value.trim());
    return ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? value.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Columns and joins that bring a plan's link cells into the statement that already reads the plan
 * (`a` = puf_active_catalog, `p` = plan). Each cell is read only from an ACTIVE snapshot, so a URL
 * from a quarantined or otherwise inactive snapshot is never served.
 */
export const PLAN_LINK_COLUMNS = `CASE WHEN link_ps.validation_state='${ACTIVE}' THEN link_pa.raw END AS link_attributes,
    CASE WHEN link_ps.validation_state='${ACTIVE}' THEN link_pa.source_row END AS link_attribute_row,
    link_n.network_url AS link_network_url,link_n.snapshot_id AS link_network_snapshot_id,
    link_n.source_row AS link_network_row`;
export const PLAN_LINK_JOINS = `LEFT JOIN snapshot link_ps ON link_ps.snapshot_id=p.snapshot_id
    LEFT JOIN plan_attribute link_pa ON link_pa.snapshot_id=p.snapshot_id AND link_pa.source_row=p.source_row
    LEFT JOIN LATERAL (
      SELECT n.network_url,n.snapshot_id,n.source_row FROM puf_import_file nf
      JOIN snapshot ns ON ns.snapshot_id=nf.snapshot_id AND ns.validation_state='${ACTIVE}'
      JOIN network n ON n.snapshot_id=nf.snapshot_id AND n.issuer_id=p.issuer_id AND n.network_id=p.network_id
        AND n.market=p.market AND n.dental_only=p.dental_only
      WHERE nf.import_id=a.import_id AND nf.kind='network'
      ORDER BY ${sqlPublishedUrl("n.network_url")} DESC,n.source_row LIMIT 1
    ) link_n ON true`;

/** The link cells `PLAN_LINK_COLUMNS` adds to a plan row. */
export type PlanLinkCells = {
  snapshot_id: string;
  link_attributes?: Record<string, unknown> | null;
  link_attribute_row?: number | null;
  link_network_url?: string | null;
  link_network_snapshot_id?: string | null;
  link_network_row?: number | null;
};

/** Every link a plan row publishes, before choosing a family. */
function planLinks(row: PlanLinkCells): LinkOut[] {
  const links: LinkOut[] = [];
  const network = publishedUrl(row.link_network_url);
  if (network && row.link_network_snapshot_id)
    links.push({
      kind: "link_out",
      rel: "provider_directory",
      url: network,
      source: "network",
      snapshot_id: row.link_network_snapshot_id,
      source_row: Number(row.link_network_row),
    });
  const attributes = row.link_attributes;
  if (attributes && row.link_attribute_row != null)
    for (const [rel, column] of Object.entries(ATTRIBUTE_URL_COLUMNS)) {
      const url = publishedUrl(attributes[column]);
      if (url)
        links.push({
          kind: "link_out",
          rel: rel as LinkOutRel,
          url,
          source: "plan_attributes",
          snapshot_id: row.snapshot_id,
          source_row: Number(row.link_attribute_row),
        });
    }
  return links;
}

/** The links of one family that a plan row publishes. */
export function planLinkOuts(
  row: PlanLinkCells | undefined,
  family: LinkOutFamily,
): LinkOut[] {
  if (!row) return [];
  return planLinks(row).filter((link) =>
    FAMILY_RELS[family].includes(link.rel),
  );
}

/** The NPI registry's public page for a ten-digit NPI; nothing for a record ID. */
export function npiRegistryLink(identity: string): LinkOut[] {
  if (!/^[12][0-9]{9}$/.test(identity)) return [];
  return [
    {
      kind: "link_out",
      rel: "npi_registry",
      url: `${NPI_REGISTRY_PAGE}${identity}`,
      source: "npi_registry",
      snapshot_id: null,
      source_row: null,
    },
  ];
}

/** The Medicare Plan Finder page for a contract-plan-segment key and contract year. */
export function medicarePlanFinderLink(
  key: { contractId: string; planId: string; segmentId: string },
  year: number,
): LinkOut[] {
  const id = `${year}-${key.contractId}-${key.planId}-${key.segmentId}`;
  return [
    {
      kind: "link_out",
      rel: "medicare_plan_finder",
      url: `${MEDICARE_PLAN_FINDER_PAGE}${id}?year=${year}&lang=en`,
      source: "medicare_plan_finder",
      snapshot_id: null,
      source_row: null,
    },
  ];
}

type Answer = { status?: unknown; links?: LinkOut[] };

/**
 * The floor: `links` appear only on an `unknown` answer. Any other answer, including one a later
 * source answered after the links were attached, leaves without them.
 */
export function withLinkOuts<T extends Answer>(
  answer: T,
  links: readonly LinkOut[] = answer.links ?? [],
): T {
  const { links: _dropped, ...rest } = answer;
  if (answer.status !== "unknown" || !links.length) return rest as T;
  return { ...rest, links: [...links] } as T;
}

/** The `links` field for a benefits answer, under the same floor as every other answer. */
export function benefitLinkOuts(
  status: "available" | "unknown",
  links: readonly LinkOut[],
): { links?: LinkOut[] } {
  const { links: kept } = withLinkOuts<Answer>({ status }, links);
  return kept ? { links: kept } : {};
}

/** `withLinkOuts` for each answer of a batch, keeping each answer's own links. */
export const linkOutFloor = <T extends Answer>(answers: T[]): T[] =>
  answers.map((answer) => withLinkOuts(answer));
