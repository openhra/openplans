import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchToCache } from "../../fetch/index.js";
import type { SnapshotMetadata } from "../../fetch/index.js";
import type { ImportFile, ImportKind } from "../puf/import-source.js";
import { IMPORT_KINDS, verifyImportFile } from "../puf/import-source.js";
import { inspectPufArchive } from "../puf/acquire-archive.js";
import { validateImportHeader } from "../puf/import-parse.js";
import { normalizeSbeRow } from "./normalize.js";
import { cachedHash } from "../geo/sources.js";

export const SBE_LANDING =
  "https://www.cms.gov/marketplace/resources/data/state-based-public-use-files";
const states: Record<string, string> = {
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  districtofcolumbia: "DC",
  georgia: "GA",
  idaho: "ID",
  illinois: "IL",
  kentucky: "KY",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  minnesota: "MN",
  nevada: "NV",
  newjersey: "NJ",
  newmexico: "NM",
  newyork: "NY",
  oregon: "OR",
  pennsylvania: "PA",
  rhodeisland: "RI",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
};
export const SBE_INDIVIDUAL_STATES = Object.values(states).filter(
  (state) => state !== "OR",
);
export interface SbeLink {
  state: string;
  year: number;
  url: string;
}
export function discoverSbe(html: string, year: number): SbeLink[] {
  let current: number | undefined;
  const links = new Map<string, SbeLink>();
  for (const token of html.matchAll(
    /<h[2-4]\b[^>]*>[\s\S]*?<\/h[2-4]>|<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi,
  )) {
    if (/^<h/i.test(token[0])) {
      const match = /\b(20\d{2})\s+SBE\s+QHP\s+PUF\s+Datasets/i.exec(
        token[0].replace(/<[^>]*>/g, ""),
      );
      if (match) current = Number(match[1]);
      continue;
    }
    if (current !== year || !token[1]) continue;
    const url = new URL(token[1].replace(/&amp;/g, "&"), SBE_LANDING);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.cms.gov" ||
      !/\.zip$/i.test(url.pathname)
    )
      continue;
    const name = url.pathname
      .split("/")
      .at(-1)!
      .replace(/[^a-z]/gi, "")
      .toLowerCase();
    const state = Object.entries(states).find(([namePrefix]) =>
      name.startsWith(namePrefix),
    )?.[1];
    if (!state) continue;
    if (links.has(state) && links.get(state)!.url !== url.href)
      throw new Error("Ambiguous SBE publication");
    links.set(state, { state, year, url: url.href });
  }
  return [...links.values()].sort((a, b) => a.state.localeCompare(b.state));
}
export async function sbePublications(
  dataDir: string,
  network = true,
): Promise<SbeLink[]> {
  const source = "cms-sbe-puf-page";
  const sha = await cachedHash(dataDir, source, SBE_LANDING);
  if (!network) {
    if (!sha) throw new Error("No cached SBE publication page");
    const bytes = await readFile(join(dataDir, "raw", source, sha, "payload"));
    if (createHash("sha256").update(bytes).digest("hex") !== sha)
      throw new Error("SBE page cache integrity failed");
    return [2026, 2027].flatMap((year) =>
      discoverSbe(bytes.toString("utf8"), year),
    );
  }
  const page = await fetchToCache(SBE_LANDING, {
    source,
    dataDir,
    allowHosts: ["www.cms.gov"],
    expectedContent: "binary",
    maxBytes: 4 * 1024 ** 2,
    expectedSha256: sha,
  });
  if (page.outcome === "not_modified")
    throw new Error("Missing SBE publication body");
  const html = await readFile(page.path, "utf8");
  return [2026, 2027].flatMap((year) => discoverSbe(html, year));
}
export async function acquireSbe(
  link: SbeLink,
  dataDir: string,
): Promise<ImportFile[]> {
  // Reuse the earlier Georgia acquisition under its original source identity.
  const source =
    link.state === "GA" && link.year === 2026
      ? "cms-sbe-ga-2026"
      : "cms-sbe-puf";
  const result = await fetchToCache(link.url, {
    source,
    dataDir,
    allowHosts: ["www.cms.gov"],
    expectedContent: "zip",
    expectedSha256: await cachedHash(dataDir, source, link.url),
  });
  if (result.outcome === "not_modified") throw new Error("Missing SBE archive");
  return bundleFiles(result.path, result.metadata, link.state);
}
export async function cachedSbe(
  link: SbeLink,
  dataDir: string,
): Promise<ImportFile[]> {
  for (const source of ["cms-sbe-puf", "cms-sbe-ga-2026"]) {
    let names: string[];
    try {
      names = await readdir(join(dataDir, "raw", source));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    const matches: SnapshotMetadata[] = [];
    for (const name of names.filter((name) => name.endsWith(".meta.json"))) {
      const m = JSON.parse(
        await readFile(join(dataDir, "raw", source, name), "utf8"),
      ) as SnapshotMetadata;
      if (m.url === link.url) matches.push(m);
    }
    const m = matches.sort((a, b) =>
      b.fetched_at.localeCompare(a.fetched_at),
    )[0];
    if (m)
      return bundleFiles(
        join(dataDir, "raw", source, m.sha256, "payload"),
        m,
        link.state,
      );
  }
  throw new Error("SBE archive has not been acquired");
}
export async function bundleFiles(
  path: string,
  metadata: SnapshotMetadata,
  state: string,
): Promise<ImportFile[]> {
  const patterns: Record<ImportKind, RegExp> = {
    "plan-attributes": /Plans\d*\.csv$/i,
    rate: /Rates\d*\.csv$/i,
    "service-area": /ServiceAreas\d*\.csv$/i,
    network: /Networks\d*\.csv$/i,
    "business-rules": /BusinessRules\d*\.csv$/i,
    "benefits-and-cost-sharing": /Benefits\d*\.csv$/i,
  };
  const files: ImportFile[] = [];
  const members = (await inspectPufArchive(path)).filter(
    (m) => !m.name.endsWith("/"),
  );
  for (const kind of IMPORT_KINDS) {
    const matches = members.filter(
      (m) =>
        patterns[kind].test(m.name) &&
        m.name.split("/").at(-1)!.startsWith(state),
    );
    if (matches.length !== 1)
      throw new Error("SBE requires exactly six named CSV members");
    const header = matches[0]!.header;
    if (!header) throw new Error("SBE member has no CSV header");
    validateImportHeader(
      kind,
      normalizeSbeRow(kind, {
        rowNumber: 1,
        recordNumber: 1,
        fields: header,
        values: Object.fromEntries(header.map((key) => [key, ""])),
      }).values,
    );
    files.push({
      kind,
      path,
      format: "zip",
      sha256: metadata.sha256,
      bytes: metadata.bytes,
      retrievedAt: metadata.fetched_at,
      url: metadata.url,
      metadata,
      source: "cms_sbe_puf",
      member: matches[0]!.name,
    });
  }
  if (
    members.filter((m) => !/Plan ID Mapping.*\.xlsx$/i.test(m.name)).length !==
    files.length
  )
    throw new Error("Unrecognized SBE bundle member");
  await verifyImportFile(files[0]!);
  return files;
}
