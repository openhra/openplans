import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { command, manifest, envelope } from "./fixture.js";

// Synthetic owner adapter. Setup registers contracts without reading storage.
const plugin: OpenPlansPlugin = {
  manifest: {
    ...manifest,
    kinds: [...manifest.kinds, "workerCommands"],
    capabilities: { writes: ["staging", "events"] },
  },
  setup(ctx) {
    ctx.operatorCommands!.add(command());
    ctx.workerCommands.add({
      argv: ["synthetic", "command"],
      usage: "Synthetic command fixture",
      timeoutMs: 5_000,
      async run(_args, context) {
        const result = await context.operatorCommandClient!.execute(envelope());
        context.log({ command_result: JSON.stringify(result) });
        return 0;
      },
    });
  },
};
export default plugin;
