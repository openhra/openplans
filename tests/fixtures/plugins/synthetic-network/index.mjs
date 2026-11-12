// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/network",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: [],
    capabilities: { network: ["download.cms.gov"] },
  },
  setup() {},
};
