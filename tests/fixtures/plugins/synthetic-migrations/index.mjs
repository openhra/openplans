// Synthetic plugin fixture: two migrations that create and index one table of its own. No
// source data.

export default {
  manifest: {
    name: "@synthetic/migrations",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: [],
    tablePrefix: "synmig",
  },
  setup() {},
};
