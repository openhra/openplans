// Synthetic plugin fixture for the MCP tool registry tests. No source data.
import { z } from "zod";

const envelope = {
  schema_version: "1",
  data_generation: "synthetic",
  provenance: [],
  notes: [],
  truncated: false,
  freshness: { checked_at: "2026-11-08T00:00:00.000Z", status: "unknown" },
  page: null,
  error: null,
};
const answers = {
  // A plain answer without a status field.
  plain: (input) => ({ echo: input.label ?? "synthetic" }),
  // An honest envelope: missing evidence is unknown.
  unknown: () => ({
    ...envelope,
    status: "unknown",
    data: { coverage: "unknown" },
  }),
  // A dishonest envelope: a denial for evidence it does not have.
  not_covered: () => ({
    ...envelope,
    status: "not_covered",
    data: { coverage: "not_covered" },
  }),
  // A nested denial inside an otherwise valid envelope.
  nested_denial: () => ({
    ...envelope,
    status: "ok",
    data: { rows: [{ status: "not_covered", evidence_refs: [], gaps: [] }] },
  }),
  // Larger than one tool result may be.
  oversized: () => ({ echo: "x".repeat(200 * 1024) }),
  // Breaks the declared output schema.
  invalid: () => ({ echo: 7 }),
};

export default {
  manifest: {
    name: "@synthetic/mcp-tools",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["mcpTools"],
    options: z
      .strictObject({
        prefix: z.string().default("synthetic_tool"),
        count: z.number().int().min(0).default(3),
        answer: z.enum(Object.keys(answers)).default("plain"),
        descriptionBytes: z.number().int().min(0).default(0),
      })
      .prefault({}),
  },
  setup(ctx) {
    const { prefix, count, answer, descriptionBytes } = ctx.options;
    for (let index = 0; index < count; index++)
      ctx.mcpTools.add({
        name: `${prefix}_${index}`,
        title: `Synthetic tool ${index}`,
        description:
          "Synthetic tool for the registry tests." +
          " synthetic".repeat(Math.ceil(descriptionBytes / 10)),
        inputSchema: z.strictObject({ label: z.string().max(40).optional() }),
        outputSchema: z.looseObject({ echo: z.string().optional() }),
        readOnly: true,
        handler: async (input) => answers[answer](input),
      });
  },
};
