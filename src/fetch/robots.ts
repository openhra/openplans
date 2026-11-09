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
