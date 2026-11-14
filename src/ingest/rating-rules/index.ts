import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Database, SqlSession } from "../../db/database.js";
import { dateParts } from "../../domain/rating/rate-row.js";

// Preserve the existing no-file TX bootstrap; full year files are explicitly selected.
export const defaultRulesFile = fileURLToPath(
  new URL("../../../data/rating-rules/default-tx.json", import.meta.url),
);

interface Rule {
  state: string;
  market: "individual";
  method: "per_member" | "unsupported";
  citation: string;
  references: string[];
  member_rate_basis?: string;
  child_rule?: string;
}
interface RulesFile {
  schema_version: "rating-rules-v1";
  plan_year: number;
  reviewed_on: string;
  rules: Rule[];
}
function parseFile(text: string): RulesFile {
  const value = JSON.parse(text) as RulesFile;
  if (
    !value ||
    value.schema_version !== "rating-rules-v1" ||
    !Number.isInteger(value.plan_year) ||
    value.plan_year < 2014 ||
    value.plan_year > 9999 ||
    !Array.isArray(value.rules)
  )
    throw new Error("Invalid rating rules document");
  dateParts(value.reviewed_on);
  const keys = new Set<string>();
  for (const rule of value.rules) {
    if (
      !rule ||
      !/^[A-Z]{2}$/.test(rule.state) ||
      rule.market !== "individual" ||
      !["per_member", "unsupported"].includes(rule.method) ||
      typeof rule.citation !== "string" ||
      !rule.citation.trim() ||
      !Array.isArray(rule.references) ||
      !rule.references.length ||
      rule.references.some(
        (url) => typeof url !== "string" || !url.startsWith("https://"),
      )
    )
      throw new Error("Invalid cited rating rule");
    if (
      rule.method === "per_member" &&
      (["NY", "VT"].includes(rule.state) ||
        rule.member_rate_basis !== "filed_rate_rows" ||
        rule.child_rule !== "three_oldest_covered_children_under_21")
    ) {
      throw new Error("Unsupported per-member rule");
    }
    const key = `${rule.state}:${rule.market}`;
    if (keys.has(key)) throw new Error("Duplicate rating rule");
    keys.add(key);
  }
  return value;
}

export async function ingestRatingRules(db: Database, path = defaultRulesFile) {
  const bytes = await readFile(path),
    document = parseFile(bytes.toString("utf8"));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const source = `openplans-rating-rules-${document.plan_year}`,
    snapshot = `${source}:${hash}`;
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1869636977)");
    await tx.query(
      `INSERT INTO source(source_id,publisher,source_kind,registry_evidence)
      VALUES ($1,'OpenPlans cited public rating rules','rating-rules',$2) ON CONFLICT DO NOTHING`,
      [
        source,
        JSON.stringify([
          ...new Set(document.rules.flatMap((rule) => rule.references)),
        ]),
      ],
    );
    await tx.query(
      `INSERT INTO snapshot(snapshot_id,source_id,retrieved_at,content_type,compressed_bytes,sha256,
      raw_path,schema_version,parser_version,expected_children,fetched_children,validation_state,activated_at)
      VALUES ($1,$2,now(),'application/json',$3,$4,$5,'rating-rules-v1','rating-rules-v1',0,0,'ACTIVE',now())
      ON CONFLICT DO NOTHING`,
      [snapshot, source, bytes.length, hash, path],
    );
    await tx.query(
      "INSERT INTO rating_rule_document(snapshot_id,raw_text) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [snapshot, bytes.toString("utf8")],
    );
    for (const [index, rule] of document.rules.entries()) {
      await tx.query(
        `INSERT INTO state_rating_rule(snapshot_id,source_row,state,plan_year,market,method,citation)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          snapshot,
          index + 1,
          rule.state,
          document.plan_year,
          rule.market,
          rule.method,
          rule.citation,
        ],
      );
    }
    await tx.query(
      `INSERT INTO rating_rule_set(plan_year,snapshot_id) VALUES ($1,$2)
      ON CONFLICT (plan_year) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`,
      [document.plan_year, snapshot],
    );
    return {
      plan_year: document.plan_year,
      snapshot_id: snapshot,
      rules: document.rules.length,
      status: "ACTIVE" as const,
    };
  });
}

export const RATING_RULE_SQL = `
    SELECT r.method,r.citation,r.snapshot_id FROM rating_rule_set a
    JOIN state_rating_rule r ON r.snapshot_id=a.snapshot_id AND r.plan_year=a.plan_year
    JOIN snapshot s ON s.snapshot_id=r.snapshot_id AND s.validation_state='ACTIVE'
    WHERE r.state=$1 AND a.plan_year=$2 AND r.market=$3`;
export async function ratingRule(
  db: SqlSession,
  state: string,
  year: number,
  market: string,
) {
  const { rows } = await db.query<{
    method: string;
    citation: string;
    snapshot_id: string;
  }>(RATING_RULE_SQL, [state, year, market.toLowerCase()]);
  return rows[0] ?? null;
}
