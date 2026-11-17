import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import type * as McpSdk from "@modelcontextprotocol/server";
import { z } from "zod";
import type { JsonSchemaType, Tool } from "@modelcontextprotocol/server";
import type { McpToolSpec } from "@openplans/plugin-sdk";
import type { SqlSession } from "../../src/db/database.js";
import {
  cachedJsonSchema,
  cachedToolDefinition,
} from "../../src/mcp/definition-cache.js";
import {
  lowestToolDefinition,
  marketSummaryToolDefinition,
} from "../../src/mcp/handy.js";
import { estimateToolDefinition } from "../../src/mcp/medicare-estimate.js";
import { coreToolDefinition } from "../../src/mcp/tools.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import { pluginToolDefinition } from "../../src/plugins/mcp-tools.js";
import {
  activateRegistries,
  currentRegistries,
  emptyRegistries,
  freezeRegistries,
} from "../../src/plugins/registries.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import { listedToolNames, post } from "./transport-helpers.js";

vi.mock("@modelcontextprotocol/server", async (original) => {
  const sdk = await original<typeof McpSdk>();
  return { ...sdk, fromJsonSchema: vi.fn(sdk.fromJsonSchema) };
});

it("compiles only a used validator and reuses it for valid and invalid calls", async () => {
  const schema: JsonSchemaType = { type: "integer" };
  const compile = vi.mocked(fromJsonSchema);
  compile.mockClear();
  const converted = cachedJsonSchema(schema);
  expect(
    converted["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  ).toBe(schema);
  expect(
    converted["~standard"].jsonSchema.output({ target: "draft-2020-12" }),
  ).toBe(schema);
  expect(compile).not.toHaveBeenCalled();
  expect(await converted["~standard"].validate(1)).toEqual({ value: 1 });
  expect(await converted["~standard"].validate("invalid")).toHaveProperty(
    "issues",
  );
  expect(await converted["~standard"].validate(2)).toEqual({ value: 2 });
  expect(compile).toHaveBeenCalledTimes(1);
});

it("negative control: eager compilation fails the discovery-work bound", async () => {
  const source = new URL("../../src/mcp/definition-cache.ts", import.meta.url);
  await withMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "let compiled: ReturnType<typeof fromJsonSchema> | undefined;",
      "let compiled: ReturnType<typeof fromJsonSchema> | undefined = fromJsonSchema(schema);",
    ),
    async (url) => {
      const mutant = await importMutant<{
        cachedJsonSchema: typeof cachedJsonSchema;
      }>(url, "cachedJsonSchema");
      vi.mocked(fromJsonSchema).mockClear();
      mutant.cachedJsonSchema({ type: "integer" });
      expect(() => expect(fromJsonSchema).not.toHaveBeenCalled()).toThrow();
    },
  );
});

it("host preparation compiles a selected schema once before any request", async () => {
  const schema: JsonSchemaType = { type: "boolean" };
  const compile = vi.mocked(fromJsonSchema);
  compile.mockClear();
  const converted = cachedJsonSchema(schema, true);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(cachedJsonSchema(schema, true)).toBe(converted);
  expect(await converted["~standard"].validate(true)).toEqual({ value: true });
  expect(await converted["~standard"].validate("invalid")).toHaveProperty(
    "issues",
  );
  expect(compile).toHaveBeenCalledTimes(1);
});

const original = currentRegistries();
afterEach(() => activateRegistries(original));

it("reuses immutable definitions and validators, including nested schema data", async () => {
  const definition = coreToolDefinition("get_data_status");
  expect(coreToolDefinition("get_data_status")).toBe(definition);
  expect(estimateToolDefinition()).toBe(estimateToolDefinition());
  expect(Object.isFrozen(definition)).toBe(true);
  expect(Object.isFrozen(definition.inputSchema.properties)).toBe(true);
  expect(Reflect.set(definition, "name", "synthetic_changed")).toBe(false);
  expect(Reflect.set(definition.inputSchema, "type", "string")).toBe(false);
  expect(coreToolDefinition("get_data_status").name).toBe("get_data_status");

  const schema: JsonSchemaType = {
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
    additionalProperties: false,
  };
  const converted = cachedJsonSchema(schema);
  expect(cachedJsonSchema(schema)).toBe(converted);
  const results = await Promise.all([
    converted["~standard"].validate({ value: 1 }),
    converted["~standard"].validate({ value: "invalid" }),
    converted["~standard"].validate({ value: 2 }),
  ]);
  expect(results[0]).toEqual({ value: { value: 1 } });
  expect(results[1]).toHaveProperty("issues");
  expect(results[2]).toEqual({ value: { value: 2 } });
});

it.each([
  ["lowest", lowestToolDefinition],
  ["market summary", marketSummaryToolDefinition],
] as const)(
  "%s keeps full and single-age discovery and validation separate",
  async (_name, definition) => {
    const input = {
      year: 2026,
      county: "48201",
      members: [{ age: 40, relationship: "subscriber", tobacco: false }],
    };
    const full = definition("full"),
      restricted = definition("single_age_silver");
    expect(definition("full")).toBe(full);
    expect(definition("single_age_silver")).toBe(restricted);
    expect(full).not.toBe(restricted);
    expect(full.inputSchema.properties).toHaveProperty("members");
    expect(restricted.inputSchema.properties).not.toHaveProperty("members");
    const validate = (schema: Tool["inputSchema"]) =>
      cachedJsonSchema(schema as JsonSchemaType)["~standard"].validate(input);
    expect(await validate(restricted.inputSchema)).toHaveProperty("issues");
    expect(await validate(full.inputSchema)).not.toHaveProperty("issues");
  },
);

// Synthetic schema versions with the same tool name stand in for a plugin reload.
function spec(value: "first" | "second"): McpToolSpec<unknown, unknown> {
  return {
    name: "synthetic_scope",
    title: "Synthetic scope",
    description: "Synthetic request isolation test.",
    readOnly: true,
    inputSchema: z.strictObject({ value: z.literal(value) }),
    outputSchema: z.strictObject({ value: z.string() }),
    handler: async () => ({ value }),
  };
}
it("a replacement plugin spec gets its own definition and validation", async () => {
  const first = spec("first"),
    second = spec("second");
  const before = pluginToolDefinition(first),
    after = pluginToolDefinition(second);
  expect(pluginToolDefinition(first)).toBe(before);
  expect(after).not.toBe(before);
  const validate = (schema: Tool["inputSchema"]) =>
    cachedJsonSchema(schema as JsonSchemaType)["~standard"].validate({
      value: "second",
    });
  expect(await validate(before.inputSchema)).toHaveProperty("issues");
  expect(await validate(after.inputSchema)).not.toHaveProperty("issues");
  first.inputSchema = second.inputSchema;
  first.title = "Synthetic revised title";
  const revised = pluginToolDefinition(first);
  expect(revised).not.toBe(before);
  expect(revised.title).toBe("Synthetic revised title");
  expect(await validate(revised.inputSchema)).not.toHaveProperty("issues");
});

const unused: SqlSession = {
  query: async () => {
    throw new Error("Unexpected SQL");
  },
  exec: async () => {},
};
it("warm discovery follows each request's grant, configuration and current plugin registry", async () => {
  const app = createMcpHttp(unused, {
    env: { OPENPLANS_MCP_TOKEN: "synthetic-token" },
    log: () => {},
  });
  const auth = { authorization: "Bearer synthetic-token" };
  for (let pass = 0; pass < 2; pass++) {
    const [granted, anonymous] = await Promise.all([
      listedToolNames(app, auth),
      listedToolNames(app),
    ]);
    expect(granted).toContain("quote_premiums");
    expect(anonymous).not.toContain("quote_premiums");
    expect(anonymous).not.toContain("get_lowest_premiums");
  }
  activateRegistries(
    freezeRegistries({
      ...emptyRegistries(),
      mcpTools: [{ plugin: "@synthetic/scope", spec: spec("first") }],
    }),
  );
  expect(await listedToolNames(app)).toContain("synthetic_scope");
  activateRegistries(original);
  expect(await listedToolNames(app)).not.toContain("synthetic_scope");
  const quotingOff = createMcpHttp(unused, {
    env: { OPENPLANS_PUBLIC_QUOTING: "off", OPENPLANS_LOWEST_PREMIUMS: "on" },
    log: () => {},
  });
  expect(await listedToolNames(quotingOff)).not.toContain("quote_plans");
  expect(await listedToolNames(quotingOff)).not.toContain(
    "get_lowest_premiums",
  );
});

it("concurrent HTTP calls keep database scopes and cancellation separate after warming definitions", async () => {
  let started!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  const db: SqlSession = {
    ...unused,
    withRequest: async (signal, run) => {
      signals.push(signal);
      return run({
        ...unused,
        query: async (_sql, parameters) => {
          if (parameters?.[0] === "cancel") {
            started();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("Synthetic cancellation")),
                { once: true },
              );
            });
          } else await resume;
          return { rows: [] };
        },
      });
    },
  };
  const tool = spec("first");
  tool.inputSchema = z.strictObject({ value: z.string() });
  tool.handler = async (input, ctx) => {
    const value = (input as { value: string }).value;
    await ctx.db.query("SELECT synthetic_scope($1)", [value]);
    return { value };
  };
  pluginToolDefinition(tool);
  activateRegistries(
    freezeRegistries({
      ...emptyRegistries(),
      mcpTools: [{ plugin: "@synthetic/scope", spec: tool }],
    }),
  );
  const app = createMcpHttp(db, { env: {}, log: () => {} });
  const controller = new AbortController();
  const request = post("tools/call", {
    name: tool.name,
    arguments: { value: "cancel" },
  });
  const cancelled = app.fetch(
    new Request(request, { signal: controller.signal }),
  );
  await waiting;
  const kept = app.fetch(
    post("tools/call", { name: tool.name, arguments: { value: "keep" } }),
  );
  controller.abort();
  release();
  const [cancelledResponse, keptResponse] = await Promise.all([
    cancelled,
    kept,
  ]);
  expect(cancelledResponse.status).toBe(504);
  await cancelledResponse.text();
  expect(keptResponse.status).toBe(200);
  expect(await keptResponse.json()).toMatchObject({
    result: { structuredContent: { value: "keep" } },
  });
  expect(signals).toHaveLength(2);
  expect(signals[0]).not.toBe(signals[1]);
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
});

it("negative control: skipping definition reuse fails the identity assertion", async () => {
  const source = new URL("../../src/mcp/definition-cache.ts", import.meta.url);
  await withMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "definitions.get(key)",
      "undefined as Tool | undefined",
    ),
    async (temporary) => {
      const mutant = await importMutant<{
        cachedToolDefinition: typeof cachedToolDefinition;
      }>(temporary, "cachedToolDefinition");
      const key = {},
        build = () => ({ ...coreToolDefinition("get_data_status") });
      expect(cachedToolDefinition(key, build)).toBe(
        cachedToolDefinition(key, build),
      );
      expect(() =>
        expect(mutant.cachedToolDefinition(key, build)).toBe(
          mutant.cachedToolDefinition(key, build),
        ),
      ).toThrow();
    },
  );
});

it("negative control: a shared scope key exposes household fields in restricted discovery", async () => {
  const source = new URL("../../src/mcp/handy.ts", import.meta.url);
  await withMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "lowestDefinitionKeys[scope]",
      "lowestDefinitionKeys.full",
    ),
    async (temporary) => {
      const mutant = await importMutant<{
        lowestToolDefinition: typeof lowestToolDefinition;
      }>(temporary, "lowestToolDefinition");
      mutant.lowestToolDefinition("full");
      expect(
        lowestToolDefinition("single_age_silver").inputSchema.properties,
      ).not.toHaveProperty("members");
      expect(() =>
        expect(
          mutant.lowestToolDefinition("single_age_silver").inputSchema
            .properties,
        ).not.toHaveProperty("members"),
      ).toThrow();
    },
  );
});
