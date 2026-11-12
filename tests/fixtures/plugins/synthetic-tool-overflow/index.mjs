// Synthetic plugin fixture for the loader tests. No source data.
import { z } from "zod";

const SYNTHETIC_TOOLS = 18;

export default {
  manifest: {
    name: "@synthetic/tool-overflow",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["mcpTools"],
  },
  setup(ctx) {
    for (let index = 0; index < SYNTHETIC_TOOLS; index++)
      ctx.mcpTools.add({
        name: `synthetic_tool_${index}`,
        title: "Synthetic tool",
        description: "Synthetic tool for the loader tests.",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        readOnly: true,
        handler: async () => ({}),
      });
  },
};
