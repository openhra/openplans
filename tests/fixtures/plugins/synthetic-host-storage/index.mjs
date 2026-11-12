// Synthetic plugin fixture: a database provider and a blob store that never connect and hold
// no source data. Each writes one marker line to stderr when an entry point selects it.

const session = {
  query: async () => ({ rows: [] }),
  exec: async () => {},
};

export default {
  manifest: {
    name: "@synthetic/host-storage",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["dbProviders", "blobStores"],
  },
  setup(ctx) {
    ctx.dbProviders.provide("synthetic-host-db", () => {
      process.stderr.write("synthetic-host-db opened\n");
      const db = {
        ...session,
        transaction: async (run) => run(session),
        withSession: async (run) => run(db),
        close: async () => {},
      };
      return db;
    });
    ctx.blobStores.provide("synthetic-host-blobs", () => {
      process.stderr.write("synthetic-host-blobs selected\n");
      return {
        put: async () => {},
        publish: async () => {},
        get: async () => undefined,
        stat: async () => undefined,
        list: async () => [],
      };
    });
  },
};
