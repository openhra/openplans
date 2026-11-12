import { sourceIds as medicareSources } from "../ingest/medicare/sources.js";
import type { MedicareFamily } from "../ingest/medicare/sources.js";
import { spufSources } from "../ingest/medicare/spuf.js";
import { GEONAMES_SOURCE } from "../ingest/geo/geonames.js";
import { sourceId as nppesSource } from "../ingest/nppes/acquire.js";
import { sourceId as rxnormSource } from "../ingest/rxnorm/acquire.js";

/**
 * The `sourceId` each core `ingest *` command reports in its `ingest.*` events. Where the
 * arguments name exactly one `source.source_id` row, that id is used. Where they do not,
 * because the run writes several sources or the cached files pick one, the command reports a
 * fixed label. Both lists are in docs/configuration.md under "Ingest event source ids". Only
 * the shapes checked here reach a payload, so a flag value such as a path never does.
 */
function flag(
  args: readonly string[],
  name: string,
  shape: RegExp,
): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  return value !== undefined && shape.test(value) ? value : undefined;
}
const STATE = /^[A-Z]{2}$/;
const YEAR = /^\d{4}$/;
const ISSUER = /^\d{5}$/;

function scoped(
  args: readonly string[],
  label: string,
  id: (year: string, state: string) => string,
): string {
  const year = flag(args, "--year", YEAR);
  const state = flag(args, "--state", STATE);
  return year && state ? id(year, state) : label;
}

export const ingestSources = {
  // Georgia can import Georgia Access files instead of the CMS SBE files, so it keeps the label.
  sbe: (args: readonly string[]) =>
    args[0] === "import" && flag(args, "--state", STATE) !== "GA"
      ? scoped(
          args,
          "cms-sbe-puf",
          (year, state) => `cms_sbe_puf:${year}:${state}`,
        )
      : "cms-sbe-puf",
  state: (args: readonly string[]) => {
    const state = flag(args, "--state", /^(?:NY|VT)$/);
    return state ? `state-rates:${state}:2026` : "state-rates";
  },
  qhpProviders: (args: readonly string[]) => {
    const issuer = flag(args, "--issuer", ISSUER);
    return issuer
      ? scoped(
          args,
          "qhp-provider",
          (year, state) => `qhp-provider-${issuer}-${year}-${state}`,
        )
      : "qhp-provider";
  },
  qhpFormulary: (args: readonly string[]) => {
    const issuer = flag(args, "--issuer", ISSUER);
    return issuer
      ? scoped(
          args,
          "qhp-formulary",
          (year, state) => `qhp-formulary-${issuer}-${year}-${state}`,
        )
      : "qhp-formulary";
  },
  qhpDiscover: "qhp-registry",
  geocode: "census-geocoder-batch",
  nppes: nppesSource,
  rxnorm: rxnormSource,
  medicare: (args: readonly string[]) => {
    if (args[0] === "part-d") {
      const kind = flag(args, "--kind", /^(?:quarterly|monthly)$/);
      return args[1] === "import" && kind
        ? spufSources[kind as keyof typeof spufSources]
        : "cms-partd-spuf";
    }
    const family = flag(args, "--family", /^[a-z_]+$/);
    return family && Object.hasOwn(medicareSources, family)
      ? medicareSources[family as MedicareFamily]
      : "cms-medicare";
  },
  taxonomy: "nucc-provider-taxonomy",
  // The source id carries the plan year from inside the rules file.
  ratingRules: "rating-rules",
  pufImport: (args: readonly string[]) =>
    scoped(
      args,
      "cms-exchange-puf",
      (year, state) => `cms-exchange-puf:${year}:${state}`,
    ),
  puf: "cms-exchange-puf",
  geo: (args: readonly string[]) =>
    args[0] === "--source" && args[1] === "geonames"
      ? GEONAMES_SOURCE
      : "census-geographies",
} as const;
