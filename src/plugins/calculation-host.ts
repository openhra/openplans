import { dataPolicyActive, withDataPolicy } from "../services/data-window.js";
import { loadConfig } from "../config/index.js";
import { calculationExecutor } from "../services/calculation-executor.js";
import { CalculationQueue } from "../services/calculation-queue.js";
import type {
  CalculationHost,
  CalculationScope,
  CoreConfigView,
} from "@openplans/plugin-sdk";
import type { SqlSession } from "../db/database.js";
import { boundedDatabase } from "../db/bounded.js";
import { enumerateHouseholdOffers } from "../services/offer-cohort.js";
import { householdDistributions } from "../services/handy.js";
import { restrictCacheLevel } from "./request-scope.js";

export const MAX_CALCULATION_OFFERS = 10_000;
const calculations = new CalculationQueue();

export function createCalculationHost(
  config: Readonly<Pick<CoreConfigView, "public" | "data">>,
): CalculationHost {
  function run<T>(
    scope: CalculationScope,
    calculate: (db: SqlSession, consumeOffer: () => void) => Promise<T>,
  ): Promise<T> {
    if (!config.public.quoting) throw new Error("quoting_disabled");
    scope.signal.throwIfAborted();
    restrictCacheLevel("request");
    const budget = scope.budget ?? { remainingOffers: MAX_CALCULATION_OFFERS };
    if (
      !Number.isSafeInteger(budget.remainingOffers) ||
      budget.remainingOffers < 0 ||
      budget.remainingOffers > MAX_CALCULATION_OFFERS
    )
      throw new Error("invalid_work_budget");
    const db = boundedDatabase(scope.db, scope.signal, { readOnly: true });
    const consumeOffer = () => {
      scope.signal.throwIfAborted();
      if (budget.remainingOffers <= 0) throw new Error("work_budget_exceeded");
      budget.remainingOffers--;
    };
    return calculations.run(scope.signal, () =>
      dataPolicyActive()
        ? calculate(db, consumeOffer)
        : withDataPolicy(config.data ?? loadConfig().data, () =>
            calculate(db, consumeOffer),
          ),
    );
  }
  return Object.freeze<CalculationHost>({
    async enumerateHouseholdOffers(input, scope) {
      return run(
        scope,
        (db, consumeOffer) =>
          calculationExecutor()?.call("enumerateHouseholdOffers", input, {
            ...scope,
            db,
          }) ?? enumerateHouseholdOffers(db, input, consumeOffer),
      );
    },
    async householdDistributions(input, scope, options) {
      return run(
        scope,
        (db, consumeOffer) =>
          calculationExecutor()?.call(
            "householdDistributions",
            input,
            { ...scope, db },
            options,
          ) ??
          householdDistributions(db, input, {
            enabled: true,
            fourProfiles: options?.fourProfiles,
            consumeOffer,
          }),
      );
    },
  });
}
