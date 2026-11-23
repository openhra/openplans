import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { publicStatusSchema } from "../plugins/status/src/views.js";
import { toolNames } from "../src/mcp/schemas.js";
import { importMutant, withMutantFile } from "./mutant-file.js";
import {
  contract,
  statusContractProblems,
  type StatusSchema,
} from "./public-contract.js";
import { replaceSyntax } from "./source-mutation.js";

describe("public contract", () => {
  it("lists exactly the public status keys the status plugin serves", () => {
    expect(statusContractProblems(publicStatusSchema as StatusSchema)).toEqual(
      [],
    );
    expect(contract.status.required).toHaveLength(10);
    expect(Object.keys(contract.status.optional)).toEqual(["usage_report"]);
    expect(contract.status.optional.usage_report?.allowed).toEqual(["off"]);
  });

  it("lists the 16 MCP tools an anonymous caller of a public instance sees", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../docs/mcp-tools.json", import.meta.url),
        "utf8",
      ),
    ) as { tools: { name: string; listed: string; plugin?: string }[] };
    const anonymous = manifest.tools
      .filter(
        (tool) =>
          tool.listed === "always" ||
          (tool.listed === "plugin" &&
            contract.mcp.public_plugins.includes(tool.plugin ?? "")),
      )
      .map((tool) => tool.name)
      .sort();
    expect(contract.mcp.anonymous_tools).toEqual(anonymous);
    expect(contract.mcp.anonymous_tools).toHaveLength(16);
    for (const name of toolNames)
      expect(contract.mcp.anonymous_tools).toContain(name);
  });

  it("keeps its lists sorted and free of repeats, so a diff shows one change per line", () => {
    for (const list of [
      contract.status.required,
      contract.mcp.anonymous_tools,
      contract.availability.row_required,
    ]) {
      expect(list).toEqual([...new Set(list)].sort());
    }
  });

  it("mutant: a status key added in the app without a contract change fails", async () => {
    const source = new URL("../plugins/status/src/views.ts", import.meta.url);
    const original = await readFile(source, "utf8");
    await withMutantFile(
      source,
      replaceSyntax(
        original,
        "health_transitions: z.strictObject({ last_change: bucket })",
        "health_transitions: z.strictObject({ last_change: bucket }),\n  planted_key: z.string()",
      ),
      async (temporary) => {
        const mutant = await importMutant<{
          publicView: unknown;
          publicStatusSchema: StatusSchema;
        }>(temporary, "publicView");
        expect(statusContractProblems(mutant.publicStatusSchema)).toEqual([
          "/status.json key planted_key is not in docs/public-contract.json",
        ]);
      },
    );
  });

  it("names a removed key and a value the schema refuses", () => {
    const surface = structuredClone(contract);
    surface.status.required.push("planted_listed_key");
    surface.status.optional.usage_report!.allowed.push("sometimes");
    expect(
      statusContractProblems(publicStatusSchema as StatusSchema, surface),
    ).toEqual([
      "docs/public-contract.json lists planted_listed_key, which the app never serves",
      '/status.json usage_report cannot be "sometimes"',
    ]);
  });
});
