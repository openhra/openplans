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

/** RFC 9309 matching; malformed access rules hold the source for review. */
export function parseRobots(text: string): RobotsPolicy {
  const groups: Group[] = [];
  let group: Group | undefined;
  let hasRules = false;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    const clean = line.split("#", 1)[0]!.trim();
    if (!clean) continue;
    const colon = clean.indexOf(":");
    if (colon < 0)
      throw new FetchError("admission_denied", "Malformed robots policy");
    const name = clean.slice(0, colon).trim().toLowerCase();
    const value = clean.slice(colon + 1).trim();
    if (name === "user-agent") {
      if (!/^(?:[a-z_-]+|\*)$/i.test(value))
        throw new FetchError("admission_denied", "Invalid robots agent");
      if (!group || hasRules) {
        group = { agents: [], rules: [], delaySeconds: 0 };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (["allow", "disallow", "crawl-delay"].includes(name)) {
      if (!group)
        throw new FetchError("admission_denied", "Ungrouped robots rule");
      hasRules = true;
      if (name === "crawl-delay") {
        if (
          !/^\d+(?:\.\d+)?$/.test(value) ||
          !Number.isFinite(Number(value)) ||
          Number(value) * 1000 > 2 ** 31 - 1
        )
          throw new FetchError("admission_denied", "Invalid robots delay");
        group.delaySeconds = Math.max(group.delaySeconds, Number(value));
      } else if (value) {
        if (!value.startsWith("/"))
          throw new FetchError("admission_denied", "Invalid robots path");
        group.rules.push({
          allow: name === "allow",
          path: normalizedPath(value),
        });
      }
    }
  }
  const specific = groups.filter((entry) => entry.agents.includes("openplans"));
  const selected = specific.length
    ? specific
    : groups.filter((entry) => entry.agents.includes("*"));
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
