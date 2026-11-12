// Synthetic plugin fixture for the loader tests. No source data.
import { z } from "zod";

const record = (entry) => {
  globalThis.syntheticPluginEvents ??= [];
  globalThis.syntheticPluginEvents.push(entry);
};

export default {
  manifest: {
    name: "@synthetic/alpha",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["routes", "workerCommands", "cacheStores", "events"],
    capabilities: { secrets: ["SYNTHETIC_ALPHA_SECRET"] },
    options: z
      .strictObject({ label: z.string().default("alpha") })
      .prefault({}),
  },
  setup(ctx) {
    const secret = ctx.secrets.get("SYNTHETIC_ALPHA_SECRET");
    record({ setup: "alpha", secretSeen: secret !== undefined });
    ctx.routes.add({
      method: "GET",
      path: "/alpha",
      exposure: "public",
      contentType: "application/json",
      handler: (c) => c.json({ label: ctx.options.label }),
    });
    ctx.workerCommands.add({
      argv: ["synthetic", "alpha"],
      usage: "worker synthetic alpha",
      run: async () => 0,
    });
    ctx.cacheStores.provide("synthetic-alpha", () => ({
      get: async () => null,
      set: async () => {},
      bytes: () => 0,
    }));
    ctx.events.on("snapshot.activated", async () => {}, {
      durable: false,
      subscriber: "synthetic-alpha",
    });
    ctx.log({ event: "ready" });
  },
  async teardown() {
    record({ teardown: "alpha" });
  },
};
