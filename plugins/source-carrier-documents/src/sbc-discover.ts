import { stateHints } from "./discover.js";
import type { DiscoveryScope } from "./discover.js";

/** An SBC PDF linked from an admitted discovery page or sitemap. */
export interface SbcLink {
  url: string;
  /** The year the link names. The printed coverage period must agree, or the document is refused. */
  urlYear: number;
  /** HIOS plan ids in the file name (14-character base ids or 17-character variant ids). */
  hiosIds: string[];
  states: string[];
}

const LINK = /\bhref\s*=\s*["']([^"'#]+)["']|<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const HIOS =
  /(?<![0-9A-Z])([0-9]{5}[A-Z]{2}[0-9]{7})(?:-?([0-9]{2}))?(?![0-9])/g;
const SBC_NAME =
  /(?:^|[^A-Za-z])SBC(?:[^A-Za-z]|$)|summary[\s_-]*of[\s_-]*benefits/i;
/** Translated editions are linked out, not parsed: the extractor reads the English template only. */
const TRANSLATED =
  /(?:^|[^A-Za-z])(?:SPA|ES|Spanish|Espanol|Español)(?:[^A-Za-z]|$)/i;
const YEAR = /(?<!\d)(20\d{2})(?!\d)/g;

const decodeEntities = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");

/** HIOS ids a file name carries: `71837TX001000100.pdf` gives `71837TX0010001-00`. */
export function fileHiosIds(fileName: string): string[] {
  const ids = new Set<string>();
  for (const match of fileName.matchAll(HIOS))
    ids.add(match[2] ? `${match[1]}-${match[2]}` : match[1]!);
  return [...ids].sort();
}

/**
 * The SBC PDFs a discovery page or sitemap lists for the run's years and states: https links on
 * the source's own hosts, ending in `.pdf`, whose file name says SBC (or "summary of benefits") or
 * carries a HIOS plan id, that are not translated editions, and whose path names exactly one year
 * (the file name's year first, else the path's), which must be a run year. That year only plans
 * the fetch: the coverage period printed in the document must say the same year.
 */
export function selectSbcLinks(
  body: string,
  base: string,
  scope: DiscoveryScope,
): SbcLink[] {
  const found = new Map<string, SbcLink>();
  for (const match of body.matchAll(LINK)) {
    let url: URL;
    try {
      url = new URL(decodeEntities((match[1] ?? match[2])!.trim()), base);
    } catch {
      continue;
    }
    if (
      url.protocol !== "https:" ||
      url.search ||
      url.username ||
      !scope.hosts.includes(url.hostname) ||
      !url.pathname.toLowerCase().endsWith(".pdf")
    )
      continue;
    const path = decodeURIComponent(url.pathname);
    const fileName = path.split("/").pop()!;
    const hiosIds = fileHiosIds(fileName);
    if (!SBC_NAME.test(fileName) && !hiosIds.length) continue;
    if (
      path
        .split("/")
        .some((part) => TRANSLATED.test(part.replace(/\.pdf$/i, "")))
    )
      continue;
    const yearsIn = (text: string) => [
      ...new Set([...text.matchAll(YEAR)].map((m) => Number(m[1]))),
    ];
    const fileYears = yearsIn(fileName.replace(HIOS, " "));
    const years = fileYears.length
      ? fileYears
      : yearsIn(path.slice(0, -fileName.length));
    if (years.length !== 1 || !scope.years.includes(years[0]!)) continue;
    const hints = stateHints(url.pathname);
    const states = hints.length
      ? scope.states.filter((state) => hints.includes(state))
      : [...scope.states];
    if (!states.length) continue;
    url.hash = "";
    found.set(url.href, { url: url.href, urlYear: years[0]!, hiosIds, states });
  }
  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}
