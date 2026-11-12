// Synthetic plugin fixture for the loader tests. No source data.
const record = (entry) => {
  globalThis.syntheticPluginEvents ??= [];
  globalThis.syntheticPluginEvents.push(entry);
};

export default {
  manifest: {
    name: "@synthetic/beta",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["routes", "blobStores", "schedules"],
  },
  setup(ctx) {
    record({ setup: "beta" });
    ctx.routes.add({
      method: "GET",
      path: "/beta",
      exposure: "public",
      contentType: "text/html",
      handler: (c) => c.html("<p>synthetic</p>"),
    });
    ctx.blobStores.provide("synthetic-beta", () => {
      throw new Error("Synthetic blob store is not used");
    });
    ctx.schedules.add({
      name: "synthetic-beta",
      cron: "*/5 * * * *",
      command: ["synthetic", "alpha"],
      maxRunMs: 1000,
    });
  },
  async teardown() {
    record({ teardown: "beta" });
  },
};
