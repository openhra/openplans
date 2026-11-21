import { ZodError } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AnnualDomain, DataPolicy } from "@openplans/plugin-sdk";
import { loadConfig } from "../config/index.js";
import type { CoreConfig } from "../config/index.js";
import type { SqlSession } from "../db/database.js";
import { sqlSessionIdentity } from "../db/bounded.js";
import { annualAdmissions, annualLoadedYears } from "../db/data-window.js";
import { dataGeneration } from "../db/generation.js";
import { resolveAnnualPolicy } from "../domain/data-window.js";
import { ReadError } from "./errors.js";

interface PolicyScope {
  config: CoreConfig["data"];
  now: Date;
  generations: WeakMap<SqlSession, Promise<string>>;
  policy?: Promise<DataPolicy>;
}
const scope = new AsyncLocalStorage<PolicyScope>();
interface PolicyEntry {
  key: string;
  policy: Promise<DataPolicy>;
  value?: DataPolicy;
}
// One entry per database bounds retention across publications and configuration changes.
const policies = new WeakMap<SqlSession, PolicyEntry>();
export const dataPolicyActive = () => scope.getStore() !== undefined;
export function withDataPolicy<T>(
  config: CoreConfig["data"],
  run: () => T,
  now = new Date(),
): T {
  return scope.run({ config, now, generations: new WeakMap() }, run);
}
export function withCurrentDataPolicy<T>(run: () => T): T {
  return dataPolicyActive() ? run() : withDataPolicy(loadConfig().data, run);
}
export function currentDataPolicy() {
  const context = scope.getStore();
  return {
    config: context?.config ?? loadConfig().data,
    time: context?.now.getTime() ?? Date.now(),
  };
}
/** Share one live generation read between the annual guards and response-cache lookup. */
export function servingGeneration(db: SqlSession): Promise<string> {
  const context = scope.getStore();
  if (!context) return dataGeneration(db);
  const identity = sqlSessionIdentity(db);
  let generation = context.generations.get(identity);
  if (!generation) {
    generation = dataGeneration(db);
    context.generations.set(identity, generation);
  }
  return generation;
}
/** Resolve only after the caller has read this request's live database generation. */
export function policyForGeneration(
  db: SqlSession,
  generation: string,
): DataPolicy | Promise<DataPolicy> {
  const context = scope.getStore();
  const config = context?.config ?? loadConfig().data;
  const now = context?.now ?? new Date();
  const key = JSON.stringify([generation, now.getUTCFullYear(), config]);
  const identity = sqlSessionIdentity(db);
  const cached = policies.get(identity);
  if (cached?.key === key) {
    if (context) context.policy ??= cached.policy;
    return cached.value ?? cached.policy;
  }
  const policy = (async () => {
    try {
      const [admissions, loaded] = await Promise.all([
        annualAdmissions(db),
        annualLoadedYears(db),
      ]);
      const resolved = resolveAnnualPolicy(
        config.historyYears,
        admissions,
        loaded,
        now,
      );
      // Plugin callers share this result with other requests.
      for (const domain of Object.values(resolved.domains)) {
        for (const years of Object.values(domain)) Object.freeze(years);
        Object.freeze(domain);
      }
      Object.freeze(resolved.domains);
      return Object.freeze(resolved);
    } catch (error) {
      if (
        error instanceof ZodError ||
        (error instanceof Error &&
          error.message === "annual_admission_dependency_invalid")
      )
        throw new ReadError({ code: "data_policy_unavailable" });
      throw error;
    }
  })();
  const entry: PolicyEntry = { key, policy };
  policies.set(identity, entry);
  void policy.then(
    (value) => {
      entry.value = value;
    },
    () => {
      if (policies.get(identity) === entry) policies.delete(identity);
    },
  );
  if (context) context.policy ??= policy;
  return policy;
}

export function servingPolicy(db: SqlSession): Promise<DataPolicy> {
  const context = scope.getStore();
  const read = async () => policyForGeneration(db, await servingGeneration(db));
  // A request may use root and transaction wrappers for the same logical database.
  return context ? (context.policy ??= read()) : read();
}
export async function requireAnnualYear(
  db: SqlSession,
  year: number,
  domain: AnnualDomain = "individual",
) {
  const policy = await servingPolicy(db);
  // Full history leaves actual source availability to the domain reader.
  if (policy.history_years === "all") return;
  if (!policy.domains[domain].allowed_years.includes(year))
    throw new ReadError({
      code: "not_loaded",
      reason: "outside_serving_window",
      required_year: year,
      domain,
      allowed_years: policy.domains[domain].allowed_years,
      policy_generation: policy.generation,
    });
}
export async function annualRows<T>(
  db: SqlSession,
  rows: T[],
  getYear: (row: T) => number | null,
  domain: AnnualDomain = "individual",
): Promise<T[]> {
  const policy = await servingPolicy(db);
  if (policy.history_years === "all") return rows;
  return rows.filter(
    (row) =>
      getYear(row) === null ||
      policy.domains[domain].allowed_years.includes(getYear(row)!),
  );
}

/** Parsed adapters call this before cache lookup; services still guard their validated inputs. */
export async function guardAnnualInput(
  db: SqlSession,
  input: Record<string, unknown>,
  domain: AnnualDomain = "individual",
) {
  const years = [input.year, input.plan_year, input.contract_year];
  for (const field of ["coverage_start", "enrollment_date"]) {
    const value = input[field];
    if (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
    )
      years.push(value.slice(0, 4));
  }
  for (const value of years)
    if (
      (typeof value === "number" && Number.isInteger(value)) ||
      (typeof value === "string" && /^\d{4}$/.test(value))
    )
      if (
        Number(value) >= 2014 &&
        Number(value) <= (domain === "medicare" ? 2100 : 9999)
      )
        await requireAnnualYear(db, Number(value), domain);
}
