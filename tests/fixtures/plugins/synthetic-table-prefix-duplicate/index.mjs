// Synthetic plugin fixture for the loader tests: it declares the table prefix that
// synthetic-migrations already uses. No source data.

export default {
  manifest: {
    name: "@synthetic/table-prefix-duplicate",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: [],
    tablePrefix: "synmig",
  },
  setup() {},
};
