import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnnualDomain, DataPolicy } from "@openplans/plugin-sdk";

export const admissionSchema = z
  .strictObject({
    domain: z.enum(["individual", "medicare"]),
    coverage_year: z.int().min(2006).max(9999),
    manifest: z.strictObject({
      schema_version: z.literal(1),
      releases: z
        .array(
          z.strictObject({
            kind: z.enum(["puf", "state", "medicare", "partd"]),
            snapshot_id: z.string().min(1),
            contract_year: z.int(),
            family: z
              .enum(["landscape", "pbp", "stars", "crosswalk", "service_area"])
              .optional(),
          }),
        )
        .min(1),
    }),
  })
  .superRefine((row, context) => {
    if (
      row.domain === "medicare" &&
      !row.manifest.releases.some(
        (release) =>
          release.kind === "medicare" &&
          (release.family ?? "landscape") === "landscape",
      )
    )
      context.addIssue({
        code: "custom",
        message: "Medicare admission requires its catalog",
      });
    for (const release of row.manifest.releases) {
      if (
        (release.kind !== "medicare" && release.family !== undefined) ||
        release.contract_year !== row.coverage_year ||
        (row.domain === "individual") !==
          ["puf", "state"].includes(release.kind)
      )
        context.addIssue({
          code: "custom",
          message: "Admission dependency year or domain differs",
        });
    }
  });
export type AnnualAdmission = z.infer<typeof admissionSchema>;
export type LoadedYears = Record<AnnualDomain, number[]>;
const ordered = (years: number[]) => [...new Set(years)].sort((a, b) => a - b);

/** Each domain retains the prior/current years and adds only its admitted next year. */
export function resolveAnnualPolicy(
  historyYears: 3 | "all",
  admissions: readonly AnnualAdmission[],
  loaded: LoadedYears,
  now: Date = new Date(),
  purpose: "serve" | "build" = "serve",
): DataPolicy {
  const calendar_year = now.getUTCFullYear();
  const validated = admissions.map((row) => admissionSchema.parse(row));
  const window = (domain: AnnualDomain) => {
    const admitted_years = ordered(
      validated
        .filter((row) => row.domain === domain)
        .map((row) => row.coverage_year),
    );
    const loaded_years = ordered(loaded[domain]);
    const allowed_years =
      historyYears === "all"
        ? ordered([...loaded_years, ...admitted_years])
        : [
            calendar_year - 1,
            calendar_year,
            ...(purpose === "build" ||
            admitted_years.includes(calendar_year + 1)
              ? [calendar_year + 1]
              : []),
          ];
    return {
      allowed_years,
      admitted_years,
      loaded_years,
      excluded_loaded_years: loaded_years.filter(
        (year) => !allowed_years.includes(year),
      ),
      missing_allowed_years: allowed_years.filter(
        (year) => !loaded_years.includes(year),
      ),
    };
  };
  const policy = {
    schema_version: 1 as const,
    history_years: historyYears,
    calendar_year,
    domains: { individual: window("individual"), medicare: window("medicare") },
  };
  const generation = createHash("sha256")
    .update(
      JSON.stringify([
        policy,
        validated.map((row) => JSON.stringify(row)).sort(),
      ]),
    )
    .digest("hex");
  return { ...policy, generation };
}
