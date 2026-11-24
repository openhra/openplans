import { FetchError } from "./errors.js";

interface Rule {
  allow: boolean;
  path: string;
}
interface Group {
  agents: string[];
  rules: Rule[];
  delaySeconds: number;
}
export interface RobotsPolicy {
  allows: (url: URL) => boolean;
  delayMs: number;
}

const twoPartSuffixes = new Set([
  "co.uk",
  "org.uk",
  "com.au",
  "org.au",
  "co.nz",
  "com.br",
]);

/** Registrable domain of a host name: the last two labels, three under a known two-part suffix. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const count = twoPartSuffixes.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-count).join(".");
}

/**
 * Whether a robots redirect from `from` to `to` stays inside one organisation (RFC 9309 2.3.1.2 follows
 * redirects; this narrows them): the same host, the same registrable domain, or a host the reviewed
 * manifest names in `robotsAliasOf`. Anything else is another organisation's answer and holds the host.
 */
export function sameOrganisation(
  from: string,
  to: string,
  aliases: readonly string[] = [],
): boolean {
  const a = from.toLowerCase();
  const b = to.toLowerCase();
  return (
    a === b ||
    registrableDomain(a) === registrableDomain(b) ||
    aliases.some((alias) => alias.toLowerCase() === b)
  );
}

/**
 * Why an HTML answer at `/robots.txt` counts as no robots file. A real 404/410 for a random path on the
 * same host proves the host answers unknown paths honestly; failing that, the shell must be byte-equal
 * to the host's index document (`indexSha256`, read only when the probe answered 200). Every other
 * probe answer (401, 403, 5xx, a different soft-200 page) leaves the shell held.
 */
export function shellBasis(
  probeStatus: number,
  robotsSha256: string,
  indexSha256?: string | null,
): "real-404" | "index-equal" | undefined {
  if (probeStatus === 404 || probeStatus === 410) return "real-404";
  if (probeStatus === 200 && indexSha256 === robotsSha256) return "index-equal";
  return undefined;
}

function normalizedPath(value: string): string {
  return value
    .replace(/[\u0080-\u{10ffff}]/gu, (character) =>
      encodeURIComponent(character),
    )
    .replace(/%[a-f0-9]{2}/gi, (escape) => {
      const character = String.fromCharCode(parseInt(escape.slice(1), 16));
      return /[a-z0-9._~-]/i.test(character) ? character : escape.toUpperCase();
    });
}

function ruleMatches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const prefix = anchored ? pattern.slice(0, -1) : pattern;
  const expression = prefix
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}${anchored ? "$" : ""}`).test(path);
}

const projectAgent = "openplans";
const maximumDelayMs = 2 ** 31 - 1;

function patternSelects(group: Group): boolean {
  return group.agents.some(
    (agent) =>
      agent !== "*" &&
      agent.includes("*") &&
      ruleMatches(projectAgent, agent.replace(/\s+/g, "")),
  );
}

/**
 * The product token of a user-agent value, case-insensitive (RFC 9309 2.2.1): `OpenPlans/1.0`
 * selects as `openplans`. A value containing `*` stays a pattern; a value with spaces keeps only
 * its first token, so `Example Spider 2.0` is `example`.
 */
function agentToken(value: string): string {
  const agent = value.toLowerCase();
  if (agent.includes("*")) return agent.replace(/\s+/g, "");
  return /^[a-z_-]+/.exec(agent)?.[0] ?? "";
}

/** Directive names, with the misspellings of Disallow common in published files so a block is never lost. */
const directiveNames: Record<string, string> = {
  "user-agent": "user-agent",
  useragent: "user-agent",
  "user agent": "user-agent",
  allow: "allow",
  disallow: "disallow",
  dissallow: "disallow",
  dissalow: "disallow",
  disalow: "disallow",
  "crawl-delay": "crawl-delay",
};

/** `name: value`, or `name value` for a known directive written without its colon. */
function directive(line: string): { name: string; value: string } | undefined {
  const colon = line.indexOf(":");
  const named =
    colon >= 0 && directiveNames[line.slice(0, colon).trim().toLowerCase()];
  if (named) return { name: named, value: line.slice(colon + 1).trim() };
  const spaced = /^(\S+)\s+(\S.*)$/.exec(line);
  const name = spaced && directiveNames[spaced[1]!.toLowerCase()];
  return name ? { name, value: spaced![2]!.trim() } : undefined;
}

/** Leading decimal seconds; "10s" reads as 10. Unreadable values are skipped (RFC 9309 2.3.1.5). */
function delaySeconds(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)/.exec(value);
  if (!match) return;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds * 1000 <= maximumDelayMs
    ? seconds
    : undefined;
}

/**
 * RFC 9309 matching. Following 2.3.1.5, unparseable lines are skipped and parseable rules are used.
 * Groups whose product token is `openplans`, else `*`, are selected. A wildcard agent pattern that
 * matches `openplans` adds its Disallow and Crawl-delay lines, so a broad block is never dropped.
 * A path without its leading slash is read with one. Rules before any user-agent line apply to
 * every agent: an ungrouped Disallow or Crawl-delay is kept, an ungrouped Allow is ignored so it
 * can never weaken a grouped Disallow. An HTML document is not a robots file and holds the source.
 */
export function parseRobots(text: string): RobotsPolicy {
  const body = text.replace(/^\uFEFF/, "");
  if (body.trimStart().startsWith("<"))
    throw new FetchError(
      "admission_denied",
      "Robots response is an HTML document, not robots directives",
    );
  const groups: Group[] = [];
  const ungrouped: Group = {
    agents: ["*", projectAgent],
    rules: [],
    delaySeconds: 0,
  };
  let group: Group | undefined;
  let hasRules = false;
  for (const line of body.split(/\r\n|\n|\r/)) {
    const parsed = directive(line.split("#", 1)[0]!.trim());
    if (!parsed) continue;
    const { name, value } = parsed;
    if (name === "user-agent") {
      if (!group || hasRules) {
        group = { agents: [], rules: [], delaySeconds: 0 };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(agentToken(value));
    } else {
      const target = group ?? ungrouped;
      if (group) hasRules = true;
      if (name === "crawl-delay") {
        const seconds = delaySeconds(value);
        if (seconds !== undefined)
          target.delaySeconds = Math.max(target.delaySeconds, seconds);
      } else if (value && (group || name === "disallow")) {
        target.rules.push({
          allow: name === "allow",
          path: normalizedPath(value.startsWith("/") ? value : `/${value}`),
        });
      }
    }
  }
  const specific = groups.filter((entry) =>
    entry.agents.includes(projectAgent),
  );
  const selectedGroups = specific.length
    ? specific
    : groups.filter((entry) => entry.agents.includes("*"));
  const selected = [
    ...selectedGroups,
    ...groups
      .filter(
        (entry) => !selectedGroups.includes(entry) && patternSelects(entry),
      )
      .map((entry) => ({
        ...entry,
        rules: entry.rules.filter((rule) => !rule.allow),
      })),
    ungrouped,
  ];
  const rules = selected.flatMap((entry) => entry.rules);
  return {
    delayMs: Math.max(0, ...selected.map((entry) => entry.delaySeconds * 1000)),
    allows(url) {
      const path = normalizedPath(url.pathname + url.search);
      const matches = rules
        .filter((rule) => ruleMatches(path, rule.path))
        .sort(
          (a, b) =>
            b.path.length - a.path.length || Number(b.allow) - Number(a.allow),
        );
      return matches[0]?.allow ?? true;
    },
  };
}
