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

describe("sources grouped behind <details>", () => {
  const sources: StatusData["sources"] = [
    ...["AK", "AL", "AZ"].flatMap((state) =>
      ["", ":rate", ":network"].map((part, i) => ({
        id: `synthetic-puf:2026:${state}${part}`,
        retrieved: new Date(NOW.getTime() - (i === 2 ? 40 : 2) * DAY),
        snapshotId: `s-${state}-${i}`,
      })),
    ),
    { id: "synthetic-outlines", retrieved: NOW, snapshotId: "s-o" },
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
      '<details><summary>synthetic-puf <span class="muted">9 snapshots, 6 under 7 days old, 3 aged 30 days or more</span></summary>',
    );
    expect(html).toContain(
      '<details><summary>synthetic-outlines <span class="muted">1 snapshot, under 1 day old</span></summary>',
    );
    // Every snapshot is still on the page, inside its family's element.
    const puf = html.slice(
      html.indexOf("<details><summary>synthetic-puf"),
      html.indexOf("</details>"),
    );
    for (const source of sources.slice(0, 9))
      expect(puf).toContain(`<td>${source.id}</td>`);
  });

  it("the operator page groups its snapshots and issuer rows the same way", () => {
    const html = renderStatusHtml(operatorView(status(["VT", "DC"], sources)));
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(
      '<details><summary>synthetic-puf <span class="muted">9 snapshots,',
    );
    expect(html).toContain("<td>s-AK-1</td>");
    expect(html).toContain("<details><summary>2 rows</summary>");
  });

  it("says none when there are no snapshots", () => {
    expect(page(status(["VT"], []))).toContain(
      '<p class="muted">Active snapshots: none.</p>',
    );
  });
});
