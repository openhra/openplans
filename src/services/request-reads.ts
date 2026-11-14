import type { SqlSession } from "../db/database.js";
import type {
  CostSharingOptions,
  CostSharingRows,
  Plan,
} from "../api/repository.js";
import {
  childDentalBenefits,
  childDentalBenefitsForPlans,
  countyPlans,
  dentalBenchmarkRates,
  dentalBenchmarkRatesForPlans,
  exchangeAttributeRows,
  exchangeAttributeRowsForPlans,
  planBenefitRows,
  planBenefitRowsForPlans,
  planCostSharing,
  planVariantRows,
  planVariantRowsForPlans,
  premiumRateRows,
  premiumRateRowsForPlans,
  SHARED_PLAN_LOOKUPS,
} from "../api/repository.js";
import { RATING_AREA_SQL } from "../ingest/geo/repository.js";
import {
  LINEAGE_COVERAGE_SQL,
  lineageAncestors,
  lineageAncestorsForPlans,
  planLineage,
  plansForCounty,
} from "../ingest/puf/import-repository.js";
import { RATING_RULE_SQL } from "../ingest/rating-rules/index.js";

const part = (value: unknown) =>
  value === undefined ? "-" : JSON.stringify(value);

/**
 * Lookups whose answer is the same for every plan a request rates: a plan import's snapshot
 * files, issuers, networks, the state rating rule, the rating area and whether any crosswalk
 * covers the state.
 */
export const REQUEST_LOOKUPS: ReadonlySet<string> = new Set([
  ...SHARED_PLAN_LOOKUPS,
  RATING_RULE_SQL,
  RATING_AREA_SQL,
  LINEAGE_COVERAGE_SQL,
]);

/** A session that runs each REQUEST_LOOKUPS statement once per distinct parameters. */
function sharedLookups(db: SqlSession): SqlSession {
  const answers = new Map<
    string,
    Promise<{ rows: Record<string, unknown>[] }>
  >();
  return {
    ...db,
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
      options?: Parameters<SqlSession["query"]>[2],
    ) {
      if (!REQUEST_LOOKUPS.has(sql))
        return db.query<Row>(sql, parameters, options);
      const key = JSON.stringify([sql, parameters ?? []]);
      let answer = answers.get(key);
      if (!answer) {
        answer = db.query(sql, parameters, options);
        answers.set(key, answer);
        // A failed lookup is not reused.
        answer.catch(() => answers.delete(key));
      }
      const { rows } = await answer;
      return { rows: rows.map((row) => ({ ...row })) as Row[] };
    },
    exec: (sql) => db.exec(sql),
  };
}

interface Batch<Row> {
  bases: ReadonlySet<string>;
  rows: Promise<Map<string, Row[]>>;
}

/**
 * Reads a request would otherwise repeat for each plan it rates: the county catalog, the plans
 * offered from it, each plan's cost sharing, the lookups in REQUEST_LOOKUPS, and the rate and
 * plan-attribute rows of the plans the request says it will rate. Create one per request with
 * `requestReads(db)` and pass it down. Nothing keeps it after the request ends, so no request
 * sees another request's reads.
 */
export function requestReads(db: SqlSession) {
  const lookups = sharedLookups(db);
  const rows = new Map<string, ReturnType<typeof plansForCounty>>();
  const offered = new Map<string, ReturnType<typeof countyPlans>>();
  const sharing = new WeakMap<
    object,
    Map<string, ReturnType<typeof planCostSharing>>
  >();
  const planned = new Set<string>();
  const rates = new Map<string, Batch<Record<string, unknown>>[]>();
  const attributes = new Map<
    string,
    Batch<{ raw: Record<string, string>; source_row: number }>[]
  >();
  const variants = new Map<string, Batch<Record<string, unknown>>[]>();
  const benefits = new Map<string, Batch<Record<string, unknown>>[]>();
  const childBenefits = new Map<string, Batch<Record<string, unknown>>[]>();
  const dentalRates = new Map<string, Batch<Record<string, unknown>>[]>();
  const ancestors = new Map<string, Batch<Record<string, unknown>>[]>();
  function once<T>(map: Map<string, T>, key: string, read: () => T): T {
    let value = map.get(key);
    if (value === undefined) map.set(key, (value = read()));
    return value;
  }
  /**
   * One base plan's rows, taken from one query over every planned plan. Plans named after that
   * query ran share the next one. A plan never named is read alone through `single`.
   */
  async function batched<Row extends Record<string, unknown>>(
    batches: Map<string, Batch<Row>[]>,
    key: string,
    base: string,
    all: (
      bases: readonly string[],
    ) => Promise<{ rows: (Row & { base_plan_id?: unknown })[] }>,
    single: () => Promise<{ rows: Row[] }>,
    strip: boolean,
    // False for batch rows that the single read for `base` would not return.
    keep: (row: Row, base: string) => boolean = () => true,
  ): Promise<{ rows: Row[] }> {
    if (!planned.has(base)) return single();
    let list = batches.get(key);
    if (!list) batches.set(key, (list = []));
    let batch = list.find((each) => each.bases.has(base));
    if (!batch) {
      // Plans named after the earlier batches ran are read together in a new one.
      const earlier = list;
      const bases = [...planned]
        .filter((id) => !earlier.some((each) => each.bases.has(id)))
        .sort();
      batch = {
        bases: new Set(bases),
        rows: all(bases).then(({ rows }) => {
          const byBase = new Map<string, Row[]>();
          for (const row of rows) {
            const id = String(row.base_plan_id);
            if (!keep(row, id)) continue;
            let group = byBase.get(id);
            if (!group) byBase.set(id, (group = []));
            if (strip) {
              const { base_plan_id: _, ...rest } = row;
              group.push(rest as unknown as Row);
            } else group.push(row);
          }
          return byBase;
        }),
      };
      list.push(batch);
    }
    let grouped;
    try {
      grouped = await batch.rows;
    } catch (error) {
      // A failed batch is not reused.
      const at = list.indexOf(batch);
      if (at >= 0) list.splice(at, 1);
      throw error;
    }
    return { rows: (grouped.get(base) ?? []).map((row) => ({ ...row })) };
  }
  /**
   * Variant and benefit rows for planCostSharing. A planned plan's rows come from one query per
   * snapshot (and, for benefits, per selected variant suffix) over every planned plan.
   */
  const costSharingRows: CostSharingRows = {
    variants: (plan) =>
      batched(
        variants,
        [plan.snapshot_id, plan.plan_year, plan.state].map(part).join("|"),
        plan.base_plan_id,
        (bases) => planVariantRowsForPlans(db, plan, bases),
        () => planVariantRows(db, plan),
        true,
      ) as ReturnType<CostSharingRows["variants"]>,
    benefits: (snapshotId, base, published) => {
      // planCostSharing selects `${base}-${suffix}`; anything else is read on its own.
      if (published !== null && !published.startsWith(`${base}-`))
        return planBenefitRows(db, snapshotId, base, published);
      const suffix =
        published === null ? null : published.slice(base.length + 1);
      return batched(
        benefits,
        [snapshotId, suffix].map(part).join("|"),
        base,
        (bases) =>
          planBenefitRowsForPlans(
            db,
            snapshotId,
            bases,
            suffix === null ? null : bases.map((b) => `${b}-${suffix}`),
          ),
        () => planBenefitRows(db, snapshotId, base, published),
        true,
        (row, id) =>
          suffix === null || row.published_plan_id === `${id}-${suffix}`,
      ) as ReturnType<CostSharingRows["benefits"]>;
    },
  };
  /** plansForCounty(db, county, year, "Individual"), read once. */
  const countyRows = (county: string, year: number) =>
    once(rows, `${county}|${year}`, () =>
      plansForCounty(lookups, county, year, "Individual"),
    );
  return {
    /** The request's session: REQUEST_LOOKUPS run once, every other query as usual. */
    db: lookups,
    countyRows,
    /** countyPlans(db, county, year, zip, coverage), read once. */
    countyPlans: (
      county: string,
      year: number,
      zip?: string,
      coverage: "medical" | "dental" = "medical",
    ) =>
      once(offered, [county, year, zip, coverage].map(part).join("|"), () =>
        countyPlans(lookups, county, year, zip, coverage, () =>
          countyRows(county, year),
        ),
      ),
    /** planCostSharing(db, plan, options), read once per plan object and options. */
    costSharing: (plan: Plan, options: CostSharingOptions = {}) => {
      let byOptions = sharing.get(plan);
      if (!byOptions) sharing.set(plan, (byOptions = new Map()));
      const key = [
        options.csrVariant,
        options.requestedVariant,
        options.allBenefits,
      ]
        .map(part)
        .join("|");
      return once(byOptions, key, () =>
        planCostSharing(lookups, plan, options, costSharingRows),
      );
    },
    /**
     * Name the plans this request will rate, before it rates the first one. Their rate and
     * attribute rows are then read in one query each, not one per plan.
     */
    plan: (plans: Iterable<{ base_plan_id: string }>) => {
      for (const plan of plans) planned.add(plan.base_plan_id);
    },
    /**
     * planLineage(db, plan.base_plan_id, plan.plan_year, plan.state). The coverage check runs
     * once per state and year. One query reads the prior-year IDs of every planned plan.
     */
    lineage: (plan: Plan) =>
      planLineage(
        lookups,
        plan.base_plan_id,
        plan.plan_year,
        plan.state,
        () =>
          batched(
            ancestors,
            part(plan.plan_year),
            plan.base_plan_id,
            (bases) => lineageAncestorsForPlans(db, bases, plan.plan_year),
            () => lineageAncestors(db, plan.base_plan_id, plan.plan_year),
            true,
          ) as ReturnType<typeof lineageAncestors>,
      ),
    /** premiumRateRows(db, snapshot, base, area). */
    rateRows: (snapshotId: string | undefined, base: string, area: string) =>
      batched(
        rates,
        `${part(snapshotId)}|${area}`,
        base,
        (bases) => premiumRateRowsForPlans(db, snapshotId, bases, area),
        () => premiumRateRows(db, snapshotId, base, area),
        false,
      ),
    /** exchangeAttributeRows(db, plan.snapshot_id, plan.base_plan_id). */
    exchangeAttributes: (plan: Pick<Plan, "snapshot_id" | "base_plan_id">) =>
      batched(
        attributes,
        plan.snapshot_id,
        plan.base_plan_id,
        (bases) => exchangeAttributeRowsForPlans(db, plan.snapshot_id, bases),
        () => exchangeAttributeRows(db, plan.snapshot_id, plan.base_plan_id),
        true,
      ),
    /** childDentalBenefits(db, snapshot, base, names). */
    childDentalBenefits: (
      snapshotId: string | undefined,
      base: string,
      names: string[],
    ) =>
      batched(
        childBenefits,
        [snapshotId, names].map(part).join("|"),
        base,
        (bases) => childDentalBenefitsForPlans(db, snapshotId, bases, names),
        () => childDentalBenefits(db, snapshotId, base, names),
        true,
      ) as ReturnType<typeof childDentalBenefits>,
    /** dentalBenchmarkRates(db, snapshot, base, area, childAgeBands). */
    dentalBenchmarkRates: (
      snapshotId: string | undefined,
      base: string,
      area: string,
      childAgeBands: string[],
    ) =>
      batched(
        dentalRates,
        [snapshotId, area, childAgeBands].map(part).join("|"),
        base,
        (bases) =>
          dentalBenchmarkRatesForPlans(
            db,
            snapshotId,
            bases,
            area,
            childAgeBands,
          ),
        () => dentalBenchmarkRates(db, snapshotId, base, area, childAgeBands),
        true,
      ) as ReturnType<typeof dentalBenchmarkRates>,
  };
}
export type RequestReads = ReturnType<typeof requestReads>;
