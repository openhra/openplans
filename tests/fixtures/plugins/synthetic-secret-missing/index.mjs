// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/secret-missing",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: [],
    capabilities: { secrets: ["SYNTHETIC_MISSING_SECRET"] },
  },
  setup() {},
};
