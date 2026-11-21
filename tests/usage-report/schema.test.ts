import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_PLUGINS } from "../../src/usage-report/first-party.js";
import {
  USAGE_REPORT_SCHEMA,
  usageReportJsonSchema,
  usageReportSchema,
} from "../../src/usage-report/schema.js";
import type { UsageReport } from "../../src/usage-report/schema.js";
import { exampleReport } from "./facts.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const committedPath = join(root, "docs/usage-report.schema.json");

describe("usage report schema v1", () => {
  it("accepts the example report and pins its name", () => {
    expect(usageReportSchema.parse(exampleReport()).schema).toBe(
      "openplans.usage-report.v1",
    );
    expect(USAGE_REPORT_SCHEMA).toBe("openplans.usage-report.v1");
  });

  it.each([
    ["top level", (r: UsageReport) => ({ ...r, zip: "77002" })],
    ["data", (r: UsageReport) => ({ ...r, data: { ...r.data, county: "x" } })],
    [
      "features",
      (r: UsageReport) => ({ ...r, features: { ...r.features, host: "x" } }),
    ],
    [
      "coverage",
      (r: UsageReport) => ({
        ...r,
        data: { ...r.data, coverage: { ...r.data.coverage, npi: true } },
      }),
    ],
    [
      "last_migration",
      (r: UsageReport) => ({
        ...r,
        last_migration: { ...r.last_migration, error: "x" },
      }),
    ],
    [
      "requests_bucket",
      (r: UsageReport) => ({
        ...r,
        requests_bucket: { rest: "0", mcp: "0", ip: "x" },
      }),
    ],
  ])("rejects an extra key in %s", (_where, mutate) => {
    expect(usageReportSchema.safeParse(mutate(exampleReport())).success).toBe(
      false,
    );
  });

  it.each([
    [
      "a raw count for states",
      { data: { years: [2026], states_bucket: "7", coverage: null } },
    ],
    ["a pre-release version", { version: "0.4.17-rc.1" }],
    ["a timestamp for the day", { sent_day: "2026-11-20T10:00:00Z" }],
    [
      "an unlisted plugin name",
      {
        features: {
          ...exampleReport().features,
          first_party_plugins: ["@acme/plugin-x"],
        },
      },
    ],
    [
      "a non-v4 install id",
      { install_id: "00000000-0000-1000-8000-000000000000" },
    ],
    ["another schema name", { schema: "openplans.usage-report.v2" }],
  ])("rejects %s", (_what, patch) => {
    expect(
      usageReportSchema.safeParse({ ...exampleReport(), ...patch }).success,
    ).toBe(false);
  });

  it("has no free-text string: every string is a const, an enum, a pattern or a format", () => {
    const loose: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}/${i}`));
      if (!node || typeof node !== "object") return;
      const schema = node as Record<string, unknown>;
      if (
        schema.type === "string" &&
        !(
          "const" in schema ||
          "enum" in schema ||
          "pattern" in schema ||
          "format" in schema
        )
      )
        loose.push(path);
      if (schema.type === "object" && schema.additionalProperties !== false)
        loose.push(`${path} (open object)`);
      for (const [key, child] of Object.entries(schema))
        walk(child, `${path}/${key}`);
    };
    walk(usageReportJsonSchema(), "#");
    expect(loose).toEqual([]);
  });

  it("docs/usage-report.schema.json equals the zod schema (regenerate: OPENPLANS_WRITE_USAGE_SCHEMA=1 npx vitest run tests/usage-report/schema.test.ts, then npx prettier --write docs/usage-report.schema.json)", async () => {
    const current = usageReportJsonSchema();
    if (process.env.OPENPLANS_WRITE_USAGE_SCHEMA === "1")
      await writeFile(committedPath, `${JSON.stringify(current, null, 2)}\n`);
    const committed: unknown = JSON.parse(
      await readFile(committedPath, "utf8"),
    );
    expect(committed).toEqual(current);
  });

  it("the plugin allowlist equals the shipped plugin packages", async () => {
    const shipped: string[] = [];
    for (const entry of await readdir(join(root, "plugins"), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const { name } = JSON.parse(
        await readFile(
          join(root, "plugins", entry.name, "package.json"),
          "utf8",
        ),
      ) as { name: string };
      if (
        name !== "@openplans/plugin-sdk" &&
        name !== "@openplans/plugin-template"
      )
        shipped.push(name);
    }
    expect([...FIRST_PARTY_PLUGINS]).toEqual(shipped.sort());
  });
});
