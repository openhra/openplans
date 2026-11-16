import type { CanonicalReader, CanonicalPlan } from "@openplans/plugin-sdk";
import { z } from "zod";
import { findPlans, requestedPlansExist } from "../api/repository.js";
import { dataGeneration } from "../api/cache/generation.js";
import { parsePlanRef } from "../services/catalog.js";
import { boundedDatabase } from "../db/bounded.js";
import { restrictCacheLevel } from "./request-scope.js";

const inputSchema = z.strictObject({
  plan_ids: z.array(z.string().min(1).max(220)).min(1).max(100),
  year: z.number().int().min(2014).max(2100),
});
const flag = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

export const canonicalReader: CanonicalReader = Object.freeze<CanonicalReader>({
  async plans(input, scope) {
    const request = inputSchema.parse(input);
    scope.signal.throwIfAborted();
    restrictCacheLevel("request");
    const db = boundedDatabase(scope.db, scope.signal, { readOnly: true });
    const ids = request.plan_ids.map(parsePlanRef);
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = await dataGeneration(db);
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
        if (!plan || !exists[index]) throw new Error("MSOT_PLAN_NOT_FOUND");
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
      if (generation === (await dataGeneration(db)))
        return Object.freeze({
          catalog_generation: generation,
          plans: Object.freeze(plans),
        });
    }
    throw new Error("MSOT_CATALOG_CHANGED");
  },
});
