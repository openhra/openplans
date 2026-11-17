import type { CalculationHost, CoreConfigView } from "@openplans/plugin-sdk";
import { dataGeneration } from "../api/cache/generation.js";
import { boundedDatabase } from "../db/bounded.js";
import { enumerateHouseholdOffers } from "../services/offer-cohort.js";
import { householdDistributions } from "../services/handy.js";
import { benchmark } from "../services/subsidies.js";
import { premiumRequest } from "../api/validation.js";
import { resolveLocation } from "../api/repository.js";
import { restrictCacheLevel } from "./request-scope.js";

export const MAX_CALCULATION_OFFERS = 10_000;

export function createCalculationHost(
  config: Readonly<Pick<CoreConfigView, "public">>,
): CalculationHost {
  const requireQuoting = () => {
    if (!config.public.quoting) throw new Error("QUOTING_DISABLED");
  };
  return Object.freeze<CalculationHost>({
    async enumerateHouseholdOffers(input, scope) {
      requireQuoting();
      scope.signal.throwIfAborted();
      restrictCacheLevel("request");
      const budget = scope.budget ?? {
        remainingOffers: MAX_CALCULATION_OFFERS,
      };
      if (
        !Number.isSafeInteger(budget.remainingOffers) ||
        budget.remainingOffers < 0 ||
        budget.remainingOffers > MAX_CALCULATION_OFFERS
      )
        throw new Error("invalid_work_budget");
      const db = boundedDatabase(scope.db, scope.signal, { readOnly: true });
      return enumerateHouseholdOffers(db, input, () => {
        scope.signal.throwIfAborted();
        if (budget.remainingOffers <= 0)
          throw new Error("work_budget_exceeded");
        budget.remainingOffers--;
      });
    },
    async householdDistributions(input, scope, options) {
      requireQuoting();
      scope.signal.throwIfAborted();
      restrictCacheLevel("request");
      const db = boundedDatabase(scope.db, scope.signal, { readOnly: true });
      return householdDistributions(db, input, {
        enabled: true,
        fourProfiles: options?.fourProfiles,
      }) as Promise<Record<string, unknown>>;
    },
    async slcsp(input, scope) {
      requireQuoting();
      scope.signal.throwIfAborted();
      restrictCacheLevel("request");
      const db = boundedDatabase(scope.db, scope.signal, { readOnly: true });
      const generation = await dataGeneration(db);
      const request = premiumRequest({
        plan_ids: ["00000TX0000000"],
        year: input.year,
        coverage_start: `${input.year}-01-01`,
        zip: input.zip,
        county: input.county,
        members: input.members.map((member) => ({
          age: member.age,
          relationship: member.relationship,
          tobacco: false,
        })),
      });
      const result = await benchmark(
        db,
        request,
        await resolveLocation(db, request.location, {
          allowCmsLive: false,
          year: request.year,
        }),
      );
      scope.signal.throwIfAborted();
      if ((await dataGeneration(db)) !== generation)
        throw new Error("DATA_CHANGED");
      return { ...result, data_generation: generation };
    },
  });
}
