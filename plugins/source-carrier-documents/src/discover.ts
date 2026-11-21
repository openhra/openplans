/** A formulary PDF linked from an admitted discovery page or sitemap. */
export interface FormularyLink {
  url: string;
  /** The year in the file name. Planning only: the year printed on the cover decides. */
  urlYear: number;
  /** Run states this document is matched against; see `stateHints`. */
  states: string[];
}

export interface DiscoveryScope {
  years: readonly number[];
  states: readonly string[];
  hosts: readonly string[];
}

const LINK = /\bhref\s*=\s*["']([^"'#]+)["']|<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const FORMULARY_NAME = /formulary|drug[\s_-]*list/i;
/** Translated editions are linked out, not parsed: the extractor reads English legends only. */
const TRANSLATED =
  /(?:^|[^A-Za-z])(?:SPA|ES|Spanish|Espanol|Español)(?:[^A-Za-z]|$)/i;
const YEAR = /(?<!\d)(20\d{2})(?!\d)/g;
const STATE_CODES = new Set(
  (
    "AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE " +
    "NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY"
  ).split(" "),
);

const decodeEntities = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");

/**
 * State codes a document's path names: a code at the start of the file name (`TXHIXFormulary`)
 * or an upper-case code standing alone between non-letters (`/TX_SBC/`). They narrow which
 * run issuers the cover is matched against; they never attach a plan by themselves.
 */
export function stateHints(pathname: string): string[] {
  const hints = new Set<string>();
  const fileName = pathname.split("/").pop() ?? "";
  const leading = /^([A-Z]{2})(?![a-z])/.exec(fileName)?.[1];
  if (leading && STATE_CODES.has(leading)) hints.add(leading);
  for (const match of pathname.matchAll(
    /(?<![A-Za-z])([A-Za-z]{2})(?![A-Za-z])/g,
  )) {
    const code = match[1]!.toUpperCase();
    if (STATE_CODES.has(code) && match[1] === match[1]!.toUpperCase())
      hints.add(code);
  }
  return [...hints].sort();
}

/**
 * The formulary PDFs a discovery page (HTML links) or sitemap (`<loc>` entries) lists for the
 * run's years and states: https links on the source's own hosts, ending in `.pdf`, whose file
 * name says formulary or drug list, is not a translated edition and carries exactly one year,
 * which must be one of the run's years.
 */
export function selectFormularyLinks(
  body: string,
  base: string,
  scope: DiscoveryScope,
): FormularyLink[] {
  const found = new Map<string, FormularyLink>();
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
    const fileName = decodeURIComponent(url.pathname.split("/").pop()!);
    if (
      !FORMULARY_NAME.test(fileName) ||
      TRANSLATED.test(fileName.replace(/\.pdf$/i, ""))
    )
      continue;
    const years = [
      ...new Set([...fileName.matchAll(YEAR)].map((m) => Number(m[1]))),
    ];
    if (years.length !== 1 || !scope.years.includes(years[0]!)) continue;
    const hints = stateHints(url.pathname);
    const states = hints.length
      ? scope.states.filter((state) => hints.includes(state))
      : [...scope.states];
    if (!states.length) continue;
    url.hash = "";
    found.set(url.href, { url: url.href, urlYear: years[0]!, states });
  }
  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}
