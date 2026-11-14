#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  dataDirectory,
  egressCountry,
  operatorManifest,
} from "../config/access.js";
import { checkFreshness, loadPublishers, planFreshness } from "./freshness.js";
import type { FreshnessTarget } from "./freshness.js";
import { shippedManifestPaths } from "./shipped.js";

const puf = (year: number, file: string): FreshnessTarget => ({
  family: `cms-exchange-puf:${year}`,
  url: `https://download.cms.gov/marketplace-puf/${year}/${file}-puf.zip`,
  mode: "head",
});

/**
 * The publications a default installation loads. Hosts that the shipped manifest holds stay in
 * the list on purpose: they report `unknown` and get no request.
 */
export const defaultTargets: readonly FreshnessTarget[] = [
  {
    family: "cms-nppes",
    url: "https://download.cms.gov/nppes/NPI_Files.html",
    mode: "index",
    match:
      "NPPES_(?:Data_Dissemination_[A-Za-z0-9_]+|Deactivated_NPI_Report_[0-9_]+)(?:_V2)?\\.zip",
  },
  ...[2025, 2026, 2027].flatMap((year) =>
    [
      "plan-attributes",
      "rate",
      "service-area",
      "benefits-and-cost-sharing",
    ].map((file) => puf(year, file)),
  ),
  {
    family: "cms-exchange-puf",
    url: "https://www.cms.gov/marketplace/resources/data/public-use-files",
    mode: "index",
    match: "marketplace-puf/[0-9]{4}/[a-z-]+\\.zip",
    served: { years: [2025, 2026, 2027] },
  },
  {
    family: "cms_sbe_puf",
    url: "https://www.cms.gov/marketplace/resources/data/state-based-public-use-files",
    mode: "index",
    match: "/files/zip/[A-Za-z0-9_-]+\\.zip",
    served: { years: [2026], exclude: "data-?dictionary" },
  },
  {
    family: "census-zcta-county-2020",
    url: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
    mode: "head",
  },
  {
    family: "census-zcta-gazetteer-2021",
    url: "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2021_Gazetteer/2021_Gaz_zcta_national.zip",
    mode: "head",
  },
  {
    family: "census-county-outlines-2024",
    url: "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip",
    mode: "head",
  },
  {
    family: "nlm-rxnorm",
    url: "https://download.nlm.nih.gov/rxnorm/",
    mode: "index",
  },
  {
    family: "nucc-taxonomy",
    url: "https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57",
    mode: "index",
  },
  {
    family: "cms-partd-spuf-quarterly",
    url: "https://data.cms.gov/sites/default/files/2026-10/062e9434-ed9d-4e83-abbd-4d64eb375949/SPUF_2026_20261007.zip",
    mode: "head",
  },
  {
    family: "cms-partd-spuf-quarterly",
    url: "https://data.cms.gov/data-api/v1/dataset-resources/58f846ab-857d-49c9-862e-0d5ee68fca57",
    mode: "index",
    match: "SPUF_[0-9]{4}_[0-9]{8}\\.zip",
  },
  {
    family: "cms-partd-spuf-monthly",
    url: "https://data.cms.gov/sites/default/files/2026-10/73ce0d29-e440-4d9a-9608-93678a50e8c8/2027_20261008.zip",
    mode: "head",
  },
  {
    family: "cms-partd-spuf-monthly",
    url: "https://data.cms.gov/data-api/v1/dataset-resources/ed1496ea-23e7-41f1-9292-172fa842ccfb",
    mode: "index",
    match: "/[0-9]{4}_[0-9]{8}\\.zip",
  },
  {
    family: "cms-medicare-landscape",
    url: "https://www.cms.gov/files/zip/cy2027-landscape-202611.zip",
    mode: "head",
  },
];

const usage = `Usage: node dist/fetch/freshness-cli.js [--plan] [--targets FILE] [--family PREFIX]

Checks whether publishers released newer files than the ones listed. Sends HEAD requests for
archives and reads small index pages only, under the reviewed access manifests. --plan prints
what would be checked and sends nothing. --targets reads a JSON array of targets, each with
family, url, mode ("head" or "index"), an optional match pattern, an optional loaded
{ lastModified, names } and an optional served { years, exclude }: listed names outside the
served years or matching exclude are reported but not compared. Output is JSON on stdout.`;

export async function main(argv: readonly string[]): Promise<number> {
  let plan = false;
  let targets = defaultTargets;
  let family: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    if (argument === "--plan") plan = true;
    else if (argument === "--targets" && argv[index + 1]) {
      const path = argv[++index] ?? "";
      if (!isAbsolute(path)) {
        console.error("--targets needs an absolute path");
        return 2;
      }
      targets = JSON.parse(readFileSync(path, "utf8")) as FreshnessTarget[];
    } else if (argument === "--family" && argv[index + 1])
      family = argv[++index];
    else {
      console.error(usage);
      return argument === "--help" ? 0 : 2;
    }
  }
  if (family) targets = targets.filter((t) => t.family.startsWith(family));
  const operator = operatorManifest();
  const manifests = [
    ...shippedManifestPaths(),
    ...(operator ? [operator] : []),
  ];
  if (plan) {
    const decisions = planFreshness(targets, loadPublishers(manifests));
    console.log(
      JSON.stringify(
        targets.map((target, index) => ({
          family: target.family,
          url: target.url,
          mode: target.mode,
          ...decisions[index],
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  const results = await checkFreshness(targets, {
    manifests,
    dataDir: dataDirectory(),
    egressCountry: egressCountry(),
  });
  console.log(JSON.stringify(results, null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = await main(process.argv.slice(2));
