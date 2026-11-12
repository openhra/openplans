// Synthetic plugin fixture for the loader tests. No source data.
import { z } from "zod";

export default {
  manifest: {
    name: "@synthetic/tool-collision",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["mcpTools"],
  },
  setup(ctx) {
    ctx.mcpTools.add({
      name: "search_plans",
      title: "Synthetic tool",
      description: "Synthetic tool for the loader tests.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      readOnly: true,
      handler: async () => ({}),
    });
  },
};
