// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/provider-collision",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["cacheStores"],
  },
  setup(ctx) {
    ctx.cacheStores.provide("memory", () => {
      throw new Error("Synthetic cache store is not used");
    });
  },
};
