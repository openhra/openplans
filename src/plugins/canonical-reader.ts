import type {
  CanonicalReader,
  CanonicalPlan,
  SqlSession,
} from "@openplans/plugin-sdk";
import { z } from "zod";
import { findPlans, requestedPlansExist } from "../api/repository.js";
import { parsePlanRef } from "../services/catalog.js";
import { boundedDatabase } from "../db/bounded.js";
import { restrictCacheLevel } from "./request-scope.js";
import { stateCatalog } from "../ingest/state/catalog.js";

const inputSchema = z.strictObject({
  plan_ids: z.array(z.string().min(1).max(220)).min(1).max(100),
  year: z.number().int().min(2014).max(2100),
});
const flag = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

// Policy receipts and audit writes do not change the public facts a preview pins.
async function catalogGeneration(db: SqlSession): Promise<string> {
  const { rows } = await db.query<{
    generation: string;
  }>(`SELECT md5(string_agg(
    table_name || ':' || revision::text, ',' ORDER BY table_name)) AS generation
    FROM api_data_generation g WHERE NOT EXISTS (
      SELECT 1 FROM row_provenance_rule r WHERE r.table_name=g.table_name
        AND left(r.table_name,4)='plg_' AND r.policy_name='app_state')`);
  if (!rows[0]?.generation) throw new Error("Data generation unavailable");
  return rows[0].generation;
}

export const canonicalReader: CanonicalReader = Object.freeze<CanonicalReader>({
  async validateScopes(input, scope) {
    const request = z
      .strictObject({
        year: z.number().int().min(2014).max(2100),
        product_families: z.array(z.enum(["medical", "dental"])).min(1),
        scopes: z
          .array(
            z.strictObject({
              issuer_id: z.string().optional(),
              state: z.string().optional(),
              market_segment: z
                .enum(["on_exchange", "off_exchange"])
                .optional(),
            }),
          )
          .max(10000),
      })
      .parse(input);
    const db = boundedDatabase(scope.db, scope.signal, { readOnly: true });
    const { rows } = await db.query<{
      issuer_id: string;
      state: string;
      product_family: "medical" | "dental";
    }>(
      `SELECT DISTINCT p.issuer_id,p.state,CASE WHEN p.dental_only THEN 'dental' ELSE 'medical' END AS product_family
       FROM plan p JOIN snapshot s ON s.snapshot_id=p.snapshot_id AND s.validation_state='ACTIVE'
       WHERE p.plan_year=$1 AND lower(p.market)='individual'`,
      [request.year],
    );
    const filed = request.product_families.includes("medical")
      ? await stateCatalog(db, request.year)
      : [];
    const identities = [
      ...rows,
      ...filed.map((r) => ({
        issuer_id: r.hios_id?.slice(0, 5) ?? r.raw_record.issuer,
        state: r.state,
        product_family: "medical" as const,
      })),
    ].filter((r) => request.product_families.includes(r.product_family));
    for (const authored of request.scopes) {
      if (
        !identities.some(
          (r) =>
            (authored.issuer_id === undefined ||
              authored.issuer_id === r.issuer_id) &&
            (authored.state === undefined || authored.state === r.state),
        )
      )
        throw new Error("msot_scope_identity_unknown");
    }
    scope.signal.throwIfAborted();
  },
  async plans(input, scope) {
    const request = inputSchema.parse(input);
    scope.signal.throwIfAborted();
    restrictCacheLevel("request");
    const db = boundedDatabase(scope.db, scope.signal, { readOnly: true });
    const ids = request.plan_ids.map(parsePlanRef);
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = await catalogGeneration(db);
      const found = await findPlans(
        db,
        ids.map((id) => id.base),
        request.year,
      );
      const exists = await requestedPlansExist(
        db,
        ids.map((id, index) => ({ ...id, plan: found[index] })),
      );
      const plans = found.map((plan, index): CanonicalPlan => {
        if (!plan || !exists[index]) throw new Error("msot_plan_not_found");
        const stateChannels =
          !plan.state_catalog || Boolean(plan.exchange_provenance);
        return Object.freeze({
          id: ids[index]!.full,
          base_plan_id: plan.base_plan_id,
          plan_year: plan.plan_year,
          issuer_id: typeof plan.issuer_id === "string" ? plan.issuer_id : null,
          state: typeof plan.state === "string" ? plan.state : null,
          product_family: plan.dental_only ? "dental" : "medical",
          business_market: plan.market.toLowerCase(),
          on_exchange: stateChannels ? flag(plan.on_exchange) : null,
          off_exchange: stateChannels ? flag(plan.off_exchange) : null,
          provenance: Object.freeze({
            snapshot_id: plan.snapshot_id,
            source_row: plan.source_row,
            channel_granularity: "base_plan",
          }),
        });
      });
      if (generation === (await catalogGeneration(db)))
        return Object.freeze({
          catalog_generation: generation,
          plans: Object.freeze(plans),
        });
    }
    throw new Error("msot_catalog_changed");
  },
});
