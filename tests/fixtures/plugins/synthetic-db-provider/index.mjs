// Synthetic plugin fixture: a database provider that never connects. No source data.

export default {
  manifest: {
    name: "@synthetic/db-provider",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["dbProviders"],
  },
  setup(ctx) {
    ctx.dbProviders.provide("synthetic-db", (settings) => ({
      synthetic: true,
      connectionString: settings.connectionString,
      query: async () => ({ rows: [] }),
      exec: async () => {},
      transaction: async (run) =>
        run({ query: async () => ({ rows: [] }), exec: async () => {} }),
      close: async () => {},
    }));
  },
};
