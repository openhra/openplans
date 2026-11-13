import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { checkedCents, dateParts } from "../../domain/rating/rate-row.js";
import type { Database, SqlSession } from "../../db/database.js";
import {
  COMMUNITY_TIERS,
  communityFamilyPremium,
  parseCents,
} from "../../domain/rating/index.js";
import type {
  CommunityFamilyRule,
  CommunityRate,
  CommunityTier,
  HouseholdMember,
} from "../../domain/rating/index.js";
import {
  reflectivePublications,
  validateReflectiveRecord,
} from "./reflective.js";
import {
  TEMPLATE_GUARD_RULE,
  validateTemplateChecks,
} from "./template-guard.js";
import type { TemplateCheck } from "./template-guard.js";
import {
  OVERRIDE_RULE,
  validateRateSourceOverrides,
  verifyRateSourceOverrides,
} from "./rate-source-override.js";
import type {
  RateSourceOverrideBlock,
  RateSourceOverrides,
} from "./rate-source-override.js";
import { loadConfig } from "../../config/index.js";

export const communityRulesFile = fileURLToPath(
  new URL(
    "../../../data/rating-rules/community-family-2026.json",
    import.meta.url,
  ),
);
interface RecordData {
  plan_id: string | null;
  plan_name?: string;
  issuer: string;
  region: string;
  prices: Record<CommunityTier, string>;
  child_only: string;
  metal: string | null;
  exchange: string;
  source_record: string;
  raw: Record<string, string>;
}
interface SourceData {
  url: string;
  sha256: string;
  bytes: number;
  retrieved_at: string;
  content_type: string;
  raw_path?: string;
  records: RecordData[];
}
export interface StateArtifact {
  schema_version: "state-rates-v1";
  state: "NY" | "VT";
  plan_year: 2026;
  sources: SourceData[];
  /** NY only: one approved-template guard decision per DFS publication. */
  template_checks?: TemplateCheck[];
  /** NY only, operator decision: refused issuers whose rates come from another public file. */
  rate_source_overrides?: RateSourceOverrideBlock;
}
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 1000;

export function parseCommunityRules(bytes: string): CommunityFamilyRule[] {
  const document = JSON.parse(bytes);
  if (
    document?.schema_version !== "community-family-rules-v1" ||
    document.plan_year !== 2026 ||
    !Array.isArray(document.rules) ||
    document.rules.length !== 2
  )
    throw new Error("Invalid community rules document");
  const states = new Set<string>();
  return document.rules.map((rule: CommunityFamilyRule) => {
    if (
      !["NY", "VT"].includes(rule.state) ||
      states.has(rule.state) ||
      rule.market !== "individual" ||
      rule.method !== "community_family_tier" ||
      rule.age_factor !== "none" ||
      rule.tobacco_factor !== "none" ||
      rule.denominator !== 100 ||
      rule.dependent_age_exclusive !== 26 ||
      !text(rule.citation) ||
      !text(rule.mapping) ||
      !Array.isArray(rule.references) ||
      !rule.references.length ||
      rule.references.some(
        (url) => !text(url) || !url.startsWith("https://"),
      ) ||
      !rule.tiers ||
      COMMUNITY_TIERS.some(
        (tier) =>
          !Number.isSafeInteger(rule.tiers[tier]) ||
          rule.tiers[tier] < 100 ||
          rule.tiers[tier] > 400,
      )
    ) {
      throw new Error("Invalid cited community rule");
    }
    states.add(rule.state);
    return { ...rule, plan_year: document.plan_year };
  });
}

// Cleanup of cached Excel IEEE-754 serialization tails, never premium arithmetic.
function cachedCellCents(value: unknown) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
    throw new Error("Invalid cached price cell");
  const cents = Number(value) * 100,
    rounded = Math.round(cents);
  if (Math.abs(cents - rounded) > 0.000001)
    throw new Error("Cached tier cell is not whole cents");
  return checkedCents(rounded);
}

function sourceAllowed(state: string, url: unknown): url is string {
  if (typeof url !== "string") return false;
  return state === "NY"
    ? /^https:\/\/myportal\.dfs\.ny\.gov\/documents\/538523\/45010883\/[A-Za-z_]+_IND_(?:BOTHX|ONX)_[A-Z]{4}-\d{9}_ApprRatesTemplate$/.test(
        url,
      )
    : url ===
        "https://info.healthconnect.vermont.gov/sites/vhc/files/documents/2026_PlanDesigns_FinalRates.pdf" ||
        reflectivePublications.some((source) => source.url === url);
}

export function parseStateArtifact(bytes: string): StateArtifact {
  const document = JSON.parse(bytes) as StateArtifact;
  if (
    document?.schema_version !== "state-rates-v1" ||
    !["NY", "VT"].includes(document.state) ||
    document.plan_year !== 2026 ||
    !Array.isArray(document.sources) ||
    !document.sources.length ||
    document.sources.length > 12
  )
    throw new Error("Invalid state rate artifact");
  const urls = new Set<string>();
  for (const source of document.sources) {
    if (
      !source ||
      !sourceAllowed(document.state, source.url) ||
      urls.has(source.url) ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(source.bytes) ||
      source.bytes <= 0 ||
      source.bytes > 50 * 1024 ** 2 ||
      !text(source.content_type) ||
      !text(source.retrieved_at) ||
      !Number.isFinite(Date.parse(source.retrieved_at)) ||
      !Array.isArray(source.records) ||
      !source.records.length ||
      source.records.length > 50_000
    )
      throw new Error("Invalid state publication");
    urls.add(source.url);
    const coordinates = new Set<string>();
    for (const record of source.records) {
      if (
        !record ||
        !text(record.issuer) ||
        !text(record.region) ||
        !text(record.source_record) ||
        coordinates.has(record.source_record) ||
        !["Yes", "No"].includes(record.child_only) ||
        !text(record.exchange) ||
        typeof record.raw !== "object" ||
        record.raw === null
      )
        throw new Error("Invalid state rate record");
      coordinates.add(record.source_record);
      if (document.state === "NY") {
        if (
          typeof record.plan_id !== "string" ||
          !/^\d{5}NY\d{7}$/.test(record.plan_id) ||
          !/^Rating Area [1-8]$/.test(record.region)
        )
          throw new Error("Invalid NY plan rate");
      } else {
        if (
          record.plan_id !== null ||
          !text(record.plan_name) ||
          record.region !== "Vermont" ||
          !["MVP", "BCBSVT"].includes(record.issuer)
        )
          throw new Error("Invalid VHC plan rate");
      }
      if (!record.prices) throw new Error("Missing filed community tiers");
      for (const tier of COMMUNITY_TIERS) {
        if (!text(record.prices[tier]))
          throw new Error("Missing filed community tier");
        parseCents(record.prices[tier]);
      }
      if (document.state === "NY") {
        const columns = {
          single: [4],
          couple: [6],
          adult_children: [7, 8, 9],
          family: [10, 11, 12],
        };
        if (
          record.raw["0"] !== record.plan_id ||
          record.raw["1"] !== record.region ||
          record.raw.rating_method !== "Family-Tier Rates" ||
          !["46023", "46023.0"].includes(record.raw.effective_serial ?? "") ||
          !["46387", "46387.0"].includes(record.raw.expiration_serial ?? "")
        )
          throw new Error("Rate identity/interval differs from raw cells");
        for (const tier of COMMUNITY_TIERS) {
          if (
            columns[tier].some(
              (column) =>
                cachedCellCents(record.raw[String(column)]) !==
                parseCents(record.prices[tier]),
            )
          ) {
            throw new Error("Filed tier differs from raw price cells");
          }
        }
      } else if (
        COMMUNITY_TIERS.some((tier) => record.raw[tier] !== record.prices[tier])
      ) {
        throw new Error("Filed tier differs from raw price cells");
      }
      if (
        document.state === "VT" &&
        reflectivePublications.some(
          (publication) => publication.url === source.url,
        )
      ) {
        validateReflectiveRecord(source, record);
      }
    }
  }
  if (document.state === "NY") {
    validateTemplateChecks(document.template_checks, document.sources, (url) =>
      sourceAllowed("NY", url),
    );
    if (document.rate_source_overrides !== undefined)
      validateRateSourceOverrides(
        document.rate_source_overrides,
        document.sources,
        document.template_checks!,
      );
  } else if (
    document.template_checks !== undefined ||
    document.rate_source_overrides !== undefined
  )
    throw new Error("Template checks apply to NY publications only");
  return document;
}

const refusedTemplates = (document: StateArtifact) =>
  (document.template_checks ?? []).filter((c) => c.decision === "refused");
const overriddenIssuers = (document: StateArtifact) =>
  new Set((document.rate_source_overrides?.issuers ?? []).map((i) => i.issuer));

export function communityRate(
  document: StateArtifact,
  source: SourceData,
  record: RecordData,
): CommunityRate {
  const prices = Object.fromEntries(
    COMMUNITY_TIERS.map((tier) => [tier, parseCents(record.prices[tier])]),
  ) as Record<CommunityTier, ReturnType<typeof parseCents>>;
  return {
    state: document.state,
    planYear: document.plan_year,
    // VT publications supply names/design labels rather than verified HIOS IDs.
    planKey: record.plan_id ?? `${record.issuer}:${record.plan_name}`,
    region: record.region,
    prices,
    childOnly: record.child_only === "Yes",
    provenance: {
      sourceUrl: source.url,
      sourceSha256: source.sha256,
      sourceRecord: record.source_record,
    },
  };
}

/** Verify original bytes, then stage atomically. This deliberately does not activate a
 * PUF catalog or change the native API's state rating authorization. */
export async function ingestStateRates(
  db: Database,
  path: string,
  state: "NY" | "VT",
  options: {
    rulesPath?: string;
    verifyRaw?: boolean;
    /** Defaults to the operator configuration's `ny.rateSourceOverrides` (off). */
    rateSourceOverrides?: RateSourceOverrides;
  } = {},
) {
  if (!isAbsolute(path) || (await stat(path)).size > 25 * 1024 ** 2)
    throw new Error("Absolute, bounded state artifact required");
  const bytes = await readFile(path),
    document = parseStateArtifact(bytes.toString("utf8"));
  if (document.state !== state)
    throw new Error("State scope differs from artifact");
  const rulesBytes = await readFile(
    options.rulesPath ?? communityRulesFile,
    "utf8",
  );
  parseCommunityRules(rulesBytes);
  if (options.verifyRaw !== false) {
    for (const source of document.sources) await verifyPublication(source);
  }
  const override = document.rate_source_overrides;
  const configured =
    state === "NY"
      ? (options.rateSourceOverrides ?? loadConfig().ny.rateSourceOverrides)
      : {};
  if (override) {
    // The cross-check runs again on the original bytes; there is no unverified path.
    if (options.verifyRaw === false)
      throw new Error(
        "NY rate source override refused: original publications must be verified",
      );
    await verifyPublication(override.publication);
    await verifyRateSourceOverrides(override, document.sources, configured);
  } else if (Object.keys(configured).length)
    throw new Error(
      "NY rate source override refused: configured, but the artifact was prepared without it",
    );
  const artifactHash = hash(bytes),
    importId = `state-rates:${state}:2026:${hash(Buffer.concat([bytes, Buffer.from(rulesBytes)]))}`;
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1869636978)");
    const sourceId = `state-rates:${state}:2026`;
    await tx.query(
      `INSERT INTO source(source_id,publisher,source_kind,registry_evidence) VALUES($1,$2,'state-rates',$3)
      ON CONFLICT(source_id) DO UPDATE SET publisher=EXCLUDED.publisher,registry_evidence=EXCLUDED.registry_evidence`,
      [
        sourceId,
        state === "NY"
          ? "New York DFS"
          : "Vermont public community-rate publications",
        JSON.stringify([
          ...document.sources.map((s) => s.url),
          ...(override ? [override.publication.url] : []),
        ]),
      ],
    );
    await tx.query(
      `INSERT INTO snapshot(snapshot_id,source_id,retrieved_at,content_type,compressed_bytes,sha256,raw_path,
      schema_version,parser_version,expected_children,fetched_children,validation_state,activated_at)
      VALUES($1,$2,now(),'application/json',$3,$4,$5,'state-rates-v1','state-rates-v1',$6,$6,'ACTIVE',now()) ON CONFLICT DO NOTHING`,
      [
        importId,
        sourceId,
        bytes.length,
        artifactHash,
        path,
        document.sources.length,
      ],
    );
    const count =
      document.sources.reduce((n, source) => n + source.records.length, 0) +
      (override?.issuers ?? []).reduce((n, i) => n + i.records.length, 0);
    await tx.query(
      `INSERT INTO state_rate_import(import_id,state,plan_year,rules_document,artifact_sha256,record_count)
      VALUES($1,$2,2026,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [importId, state, rulesBytes, artifactHash, count],
    );
    for (const [sourceIndex, source] of document.sources.entries()) {
      const publication = `${sourceId}:publication:${source.sha256}`;
      await tx.query(
        `INSERT INTO snapshot(snapshot_id,source_id,retrieved_at,content_type,compressed_bytes,sha256,raw_path,
        schema_version,parser_version,expected_children,fetched_children,validation_state,activated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'state-publication-v1','state-rates-v1',0,0,'ACTIVE',now()) ON CONFLICT DO NOTHING`,
        [
          publication,
          sourceId,
          source.retrieved_at,
          source.content_type,
          source.bytes,
          source.sha256,
          source.raw_path ?? "fixture",
        ],
      );
      for (const [recordIndex, record] of source.records.entries()) {
        const rate = communityRate(document, source, record);
        await tx.query(
          `INSERT INTO state_community_rate(import_id,source_index,record_index,publication_snapshot_id,plan_key,region,rate,raw_record)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            importId,
            sourceIndex,
            recordIndex,
            publication,
            rate.planKey,
            rate.region,
            JSON.stringify(rate),
            JSON.stringify(record),
          ],
        );
      }
    }
    if (override) {
      // Staged after the DFS sources, under the SBE bundle's own publication snapshot.
      const p = override.publication;
      const publication = `${sourceId}:publication:${p.sha256}`;
      await tx.query(
        `INSERT INTO snapshot(snapshot_id,source_id,requested_url,retrieved_at,content_type,compressed_bytes,sha256,raw_path,
        schema_version,parser_version,expected_children,fetched_children,validation_state,activated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'state-publication-v1',$9,0,0,'ACTIVE',now()) ON CONFLICT DO NOTHING`,
        [
          publication,
          sourceId,
          p.url,
          p.retrieved_at,
          p.content_type,
          p.bytes,
          p.sha256,
          p.raw_path,
          OVERRIDE_RULE,
        ],
      );
      const sourceIndex = document.sources.length;
      let recordIndex = 0;
      for (const entry of override.issuers) {
        for (const record of entry.records) {
          const rate = communityRate(
            document,
            { ...p, records: [] },
            record as RecordData,
          );
          await tx.query(
            `INSERT INTO state_community_rate(import_id,source_index,record_index,publication_snapshot_id,plan_key,region,rate,raw_record)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [
              importId,
              sourceIndex,
              recordIndex++,
              publication,
              rate.planKey,
              rate.region,
              JSON.stringify(rate),
              JSON.stringify(record),
            ],
          );
        }
        // Why this issuer's rates have another source, kept with the import.
        await tx.query(
          `INSERT INTO quality_issue(source_id,snapshot_id,source_record,severity,issue_code,explanation)
          SELECT $1,$2,$3,'info','rate_source_override',$4 WHERE NOT EXISTS (
            SELECT 1 FROM quality_issue WHERE snapshot_id=$2 AND source_record=$3 AND issue_code='rate_source_override')`,
          [
            sourceId,
            importId,
            entry.issuer,
            JSON.stringify({
              status: "filed",
              rule: override.rule,
              source: entry.source,
              note: entry.quality_note,
              publication: {
                url: p.url,
                sha256: p.sha256,
                member: p.member,
                member_sha256: p.member_sha256,
              },
              refused_template: entry.refused_template,
              cross_check: override.cross_check,
              records: entry.records.length,
              unknown_plans: entry.unknown_plans,
            }),
          ],
        );
      }
    }
    // A refused template is kept as a quarantined receipt, with one quality issue per
    // issuer carrying the reason code and evidence. Its rates are never staged.
    for (const check of refusedTemplates(document)) {
      const refused = `${importId}:refused:${check.sha256}`;
      await tx.query(
        `INSERT INTO snapshot(snapshot_id,source_id,requested_url,retrieved_at,content_type,compressed_bytes,sha256,
        schema_version,parser_version,expected_children,fetched_children,validation_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'state-publication-v1',$8,0,0,'QUARANTINED') ON CONFLICT DO NOTHING`,
        [
          refused,
          sourceId,
          check.url,
          check.retrieved_at,
          check.content_type,
          check.bytes,
          check.sha256,
          TEMPLATE_GUARD_RULE,
        ],
      );
      for (const issuer of check.issuer_ids) {
        await tx.query(
          `INSERT INTO quality_issue(source_id,snapshot_id,source_record,severity,issue_code,explanation)
          SELECT $1,$2,$3,'warning',$4,$5 WHERE NOT EXISTS (
            SELECT 1 FROM quality_issue WHERE snapshot_id=$2 AND source_record=$3 AND issue_code=$4)`,
          [
            sourceId,
            refused,
            issuer,
            check.reason,
            JSON.stringify({
              status: "unknown",
              url: check.url,
              filing: check.filing,
              evidence: check.evidence,
              listed_plans: (check.listed_plans ?? []).filter((p) =>
                p.plan_id.startsWith(issuer),
              ),
            }),
          ],
        );
      }
    }
    await tx.query(
      `INSERT INTO state_rate_active(state,plan_year,import_id) VALUES($1,2026,$2)
      ON CONFLICT(state,plan_year) DO UPDATE SET import_id=EXCLUDED.import_id`,
      [state, importId],
    );
    return {
      state,
      plan_year: 2026,
      status: "STAGED" as const,
      import_id: importId,
      records: count,
      publications: document.sources.length,
      unknown_issuers: refusedTemplates(document).flatMap((check) =>
        check.issuer_ids
          .filter((issuer) => !overriddenIssuers(document).has(issuer))
          .map((issuer) => ({ issuer, reason: check.reason })),
      ),
      ...(override
        ? {
            rate_source_overrides: override.issuers.map((entry) => ({
              issuer: entry.issuer,
              source: entry.source,
              records: entry.records.length,
              unknown_plans: entry.unknown_plans.length,
            })),
          }
        : {}),
      native_api_status: "unsupported_rating_method" as const,
    };
  });
}

async function verifyPublication(publication: {
  raw_path?: string;
  bytes: number;
  sha256: string;
}) {
  if (!publication.raw_path || !isAbsolute(publication.raw_path))
    throw new Error("Original publication path required");
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(publication.raw_path)) {
    size += chunk.length;
    if (size > publication.bytes)
      throw new Error("Original publication size mismatch");
    digest.update(chunk);
  }
  if (size !== publication.bytes || digest.digest("hex") !== publication.sha256)
    throw new Error("Original publication hash mismatch");
}

export async function stagedStatePremium(
  db: SqlSession,
  state: "NY" | "VT",
  planKey: string,
  region: string,
  members: readonly HouseholdMember[],
  coverageStart: string,
) {
  const { year } = dateParts(coverageStart);
  const result = await db.query<{
    rate: CommunityRate;
    rules_document: { rules: CommunityFamilyRule[]; plan_year: number };
  }>(
    `
    SELECT r.rate,i.rules_document FROM state_rate_active a JOIN state_rate_import i ON i.import_id=a.import_id
    JOIN state_community_rate r ON r.import_id=i.import_id JOIN snapshot s ON s.snapshot_id=i.import_id AND s.validation_state='ACTIVE'
    WHERE a.state=$1 AND a.plan_year=$2 AND r.plan_key=$3 AND r.region=$4`,
    [state, year, planKey, region],
  );
  if (!result.rows.length) {
    const refusal = await templateRefusal(db, state, year, planKey);
    if (refusal)
      return { status: "unknown", reason: refusal, totalCents: null };
  }
  if (result.rows.length !== 1)
    return {
      status: result.rows.length ? "ambiguous" : "missing",
      totalCents: null,
    };
  const row = result.rows[0]!;
  const rule = {
    ...row.rules_document.rules.find((rule) => rule.state === state)!,
    plan_year: row.rules_document.plan_year,
  };
  return communityFamilyPremium(rule, row.rate, members, coverageStart);
}

/** The active import refused this plan's issuer template, so its rate is unknown. */
async function templateRefusal(
  db: SqlSession,
  state: "NY" | "VT",
  year: number,
  planKey: string,
) {
  if (state !== "NY") return null;
  const { rows } = await db.query<{ issue_code: string }>(
    `SELECT q.issue_code FROM state_rate_active a
    JOIN quality_issue q ON starts_with(q.snapshot_id, a.import_id || ':refused:')
    WHERE a.state=$1 AND a.plan_year=$2 AND q.source_record=$3
    ORDER BY q.issue_code LIMIT 1`,
    [state, year, planKey.slice(0, 5)],
  );
  return rows[0]?.issue_code ?? null;
}
