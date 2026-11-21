import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import {
  operatorView,
  placesPhrase,
  publicView,
  renderStatusHtml,
  stateCodes,
} from "../src/index.js";
import type { StatusData } from "../src/index.js";
import type * as htmlModule from "../src/html.js";
import { STYLE } from "../src/html.js";

const htmlModuleStyle = () => STYLE;

const htmlFile = fileURLToPath(new URL("../src/html.ts", import.meta.url));
const NOW = new Date("2026-11-13T12:00:00Z");
const DAY = 86_400_000;

// Synthetic coverage rows: only the state code matters to the page's wording.
function rows(states: string[]): NonNullable<StatusData["availability"]> {
  return states.map((state, i) => ({
    state,
    year: 2026,
    market: "individual",
    issuer_id: String(10_000 + i),
    catalog: "available",
    premium: "available",
    provider: "unknown",
    formulary: "unknown",
    snapshot_id: null,
  }));
}

// 48 synthetic codes (QA to XV), none of them DC or a territory, then DC: the hosted preview's shape.
const FORTY_EIGHT = Array.from(
  { length: 48 },
  (_, i) => (i < 26 ? "Q" : "X") + String.fromCharCode(65 + (i % 26)),
);

function status(
  states: string[],
  sources: StatusData["sources"] = [],
): StatusData {
  return {
    now: NOW,
    version: "0.0.0",
    db: "ok",
    poolWaiting: null,
    usageReport: false,
    availability: rows(states),
    sources,
    ingests: [],
    cache: { enabled: false, backend: "none", stats: null },
    passthrough: [],
    plugins: [],
    events: [],
    health: { lastChange: null, history: [] },
  };
}

const page = (data: StatusData) =>
  renderStatusHtml(publicView(data), stateCodes(data));

describe("states and DC wording", () => {
  it("counts DC apart from the states, from the data", () => {
    const data = status([...FORTY_EIGHT, "DC", "DC", "QA"]);
    // The JSON number is unchanged: DC is one of the 49 places it counts.
    expect(publicView(data).data.states).toBe(49);
    expect(page(data)).toContain("<p>48 states and DC, plan years 2026.</p>");
    expect(page(data)).not.toContain("49 states");
  });

  it("follows other data instead of a fixed sentence", () => {
    expect(placesPhrase(["VT", "DC", "PR"])).toBe("1 state, DC and PR");
    expect(placesPhrase(["VT", "NY"])).toBe("2 states");
    expect(placesPhrase(["DC"])).toBe("DC");
    expect(placesPhrase([])).toBe("no states");
    expect(page(status(["VT", "NY", "TX"]))).toContain("<p>3 states, ");
  });

  it("the operator page works the wording out from its issuer rows", () => {
    const data = status(["VT", "DC"]);
    expect(renderStatusHtml(operatorView(data))).toContain(
      "<p>1 state and DC, plan years 2026.</p>",
    );
  });

  it("planted mutant: counting DC as a state brings back the old wording", async () => {
    const mutant = await plantMutant(
      htmlFile,
      'export const NOT_STATES = ["DC", "PR", "GU", "VI", "AS", "MP"] as const;',
      "export const NOT_STATES = [] as const;",
    );
    try {
      const html = (await import(mutant.path)) as typeof htmlModule;
      const data = status([...FORTY_EIGHT, "DC"]);
      const text = html.renderStatusHtml(publicView(data), stateCodes(data));
      expect(text).toContain("49 states,");
      expect(text).not.toContain("48 states and DC");
    } finally {
      await mutant.cleanup();
    }
  });

  it("planted mutant: a fixed sentence fails on other data", async () => {
    const mutant = await plantMutant(
      htmlFile,
      "codes ? placesPhrase(codes) :",
      '"48 states and DC" ??',
    );
    try {
      const html = (await import(mutant.path)) as typeof htmlModule;
      const data = status(["VT", "DC"]);
      expect(
        html.renderStatusHtml(publicView(data), stateCodes(data)),
      ).not.toContain("1 state and DC");
    } finally {
      await mutant.cleanup();
    }
  });
});

// Synthetic publisher dates by file: plan file, rate file, network file (none recorded).
const SYNTHETIC_PUBLISHED = ["2025-08-12", "2026-10-30", null] as const;

describe("sources grouped behind <details>", () => {
  const sources: StatusData["sources"] = [
    ...["AK", "AL", "AZ"].flatMap((state) =>
      ["", ":rate", ":network"].map((part, i) => ({
        id: `synthetic-puf:2026:${state}${part}`,
        retrieved: new Date(NOW.getTime() - (i === 2 ? 40 : 2) * DAY),
        snapshotId: `s-${state}-${i}`,
        // Synthetic publisher dates: two per state, the network file has none.
        published: SYNTHETIC_PUBLISHED[i] ?? null,
        publishedFrom: i === 2 ? null : ("last_modified" as const),
      })),
    ),
    {
      id: "synthetic-outlines",
      retrieved: NOW,
      snapshotId: "s-o",
      published: null,
      publishedFrom: null,
    },
  ];

  it("gives one summary per source family with counts, and no script", () => {
    const html = page(status(["VT"], sources));
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(
      "Active snapshots: 10 from 2 sources. Open a source to see each snapshot.",
    );
    expect(html.match(/<details>/g)).toHaveLength(2);
    expect(html.match(/<\/details>/g)).toHaveLength(2);
    expect(html).toContain(
      '<details><summary>synthetic-puf <span class="muted">9 snapshots, 6 retrieved under 7 days ago, 3 retrieved 30 days ago or more; published 2025-08-12 to 2026-10-30, 3 unknown</span></summary>',
    );
    expect(html).toContain(
      '<details><summary>synthetic-outlines <span class="muted">1 snapshot, retrieved under 1 day ago; publisher date unknown</span></summary>',
    );
    // Every snapshot is still on the page, inside its family's element.
    const puf = html.slice(
      html.indexOf("<details><summary>synthetic-puf"),
      html.indexOf("</details>"),
    );
    for (const source of sources.slice(0, 9))
      expect(puf).toContain(`<td class="token">${source.id}</td>`);
  });

  it("the operator page groups its snapshots and issuer rows the same way", () => {
    const html = renderStatusHtml(operatorView(status(["VT", "DC"], sources)));
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(
      '<details><summary>synthetic-puf <span class="muted">9 snapshots,',
    );
    expect(html).toContain('<td class="token">s-AK-1</td>');
    expect(html).toContain("<details><summary>2 rows</summary>");
  });

  it("says none when there are no snapshots", () => {
    expect(page(status(["VT"], []))).toContain(
      '<p class="muted">Active snapshots: none.</p>',
    );
  });
});

/**
 * Rules in the inline CSS that let a table cell break inside a word. Only `td.token` cells
 * (IDs, hashes, times, JSON) may do that; headers and word columns wrap at spaces.
 */
function wordBreakingRules(style: string): string[] {
  const found: string[] = [];
  for (const [, selectors, body] of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      !/overflow-wrap:\s*(anywhere|break-word)|word-break:\s*break-(all|word)/.test(
        body!,
      )
    )
      continue;
    for (const selector of selectors!.split(","))
      if (
        /(^|[\s>+~])(th|td|tr|table|thead|tbody|caption)\b|\.table\b/.test(
          selector.trim(),
        ) &&
        !selector.includes(".token")
      )
        found.push(selector.trim());
  }
  return found;
}

describe("table cells break words only in token columns", () => {
  const data: StatusData = {
    ...status(
      ["VT", "DC"],
      [
        {
          id: "synthetic-puf:2026:VT:rate",
          retrieved: NOW,
          snapshotId: "s-VT-0",
          published: "2026-10-30",
          publishedFrom: "release_date",
        },
      ],
    ),
    ingests: [
      {
        source: "synthetic-puf",
        lastSuccess: NOW,
        reasonCodes: [],
        durationsMs: [],
      },
    ],
    passthrough: [
      {
        id: "synthetic-passthrough",
        enabled: true,
        level: "stored",
        exhausted: false,
        dailyRequests: 1,
        maxDailyRequests: 10,
        blockedUntil: null,
        hitRate: null,
      },
    ],
  };

  it("the inline CSS breaks anywhere only in td.token", () => {
    expect(wordBreakingRules(htmlModuleStyle())).toEqual([]);
    expect(htmlModuleStyle()).toMatch(
      /td\.token \{ overflow-wrap: anywhere; \}/,
    );
    expect(htmlModuleStyle()).not.toMatch(/hyphens:\s*auto/);
    // A publisher date stays on one line instead of splitting at its hyphens.
    expect(htmlModuleStyle()).toMatch(/td\.date \{ white-space: nowrap; \}/);
  });

  it("word columns are plain cells and long IDs are token cells", () => {
    const html = page(data);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<th[^>]*class=/);
    // Rows by status: every cell is a word or a count.
    expect(html).toContain(
      "<tr><td>available</td><td>2</td><td>2</td><td>0</td><td>0</td></tr>",
    );
    expect(html).toContain("<td>unavailable</td>");
    // Sources and imports: the ID may break, the age may not.
    expect(html).toContain(
      '<tr><td class="token">synthetic-puf:2026:VT:rate</td><td>under 1 day ago</td><td class="token date">2026-10-30</td></tr>',
    );
    expect(html).toContain(
      '<tr><td class="token">synthetic-puf</td><td>under 1 day</td></tr>',
    );
    expect(html).toContain(
      '<tr><td class="token">synthetic-passthrough</td><td>yes</td><td>ok</td><td>stored</td></tr>',
    );
  });

  it("each table sits in a labelled region that scrolls on its own", () => {
    const html = page(data);
    expect(html).toContain(
      '<div class="table" role="region" tabindex="0" aria-label="Rows by status"><table>',
    );
    expect(html.match(/<div class="table"/g)!.length).toBe(
      html.match(
        /<div class="table" role="region" tabindex="0" aria-label="[^"]+">/g,
      )!.length,
    );
    expect(htmlModuleStyle()).toContain(".table { overflow-x: auto; }");
  });

  it("planted mutant: anywhere on every cell is caught", async () => {
    const mutant = await plantMutant(
      htmlFile,
      // The CSS is one template literal, so the mutant prepends a rule to it.
      "export const STYLE =",
      'export const STYLE = "th, td { overflow-wrap: anywhere; }" +',
    );
    try {
      const html = (await import(mutant.path)) as typeof htmlModule;
      expect(wordBreakingRules(html.STYLE)).toEqual(["th", "td"]);
    } finally {
      await mutant.cleanup();
    }
  });

  it("planted mutant: marking every column as a token column is caught", async () => {
    const mutant = await plantMutant(
      htmlFile,
      "tokens.includes(column)",
      "tokens.length >= 0",
    );
    try {
      const html = (await import(mutant.path)) as typeof htmlModule;
      const text = html.renderStatusHtml(publicView(data), stateCodes(data));
      expect(text).not.toContain("<td>unavailable</td>");
      expect(text).toContain('<td class="token">under 1 day</td>');
    } finally {
      await mutant.cleanup();
    }
  });
});
