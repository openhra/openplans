// Synthetic plugin fixture for the route wrapper tests. No source data.

const calls = (globalThis.syntheticRouteCalls ??= {});
const count = (path) => (calls[path] = (calls[path] ?? 0) + 1);

export default {
  manifest: {
    name: "@synthetic/routes",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["routes"],
    capabilities: { operatorRoutes: true },
  },
  setup(ctx) {
    const json = (path, exposure, body, extra = {}) =>
      ctx.routes.add({
        method: "GET",
        path,
        exposure,
        contentType: "application/json",
        handler: (c) => c.json({ ...body, calls: count(path) }),
        ...extra,
      });
    json(
      "/synthetic/public",
      "public",
      { synthetic: true },
      {
        rateLimit: { perMinute: 3, activePerSource: 2, activeTotal: 8 },
        cache: { ttlSeconds: 60 },
      },
    );
    json(
      "/synthetic/operator",
      "operator",
      { synthetic: true },
      { cache: { ttlSeconds: 60 } },
    );
    json("/synthetic/leak", "public", {
      rows: [{ id: "synthetic-row", sourced_by: "synthetic-leak-value" }],
    });
    json("/synthetic/secret", "public", { api_key: "synthetic-key-value" });
    ctx.routes.add({
      method: "GET",
      path: "/synthetic/page",
      exposure: "public",
      contentType: "text/html",
      handler: (c) => c.html("<p>synthetic</p>"),
    });
    ctx.routes.add({
      method: "GET",
      path: "/synthetic/slow",
      exposure: "public",
      contentType: "application/json",
      handler: () => new Promise(() => {}),
    });
    ctx.routes.add({
      method: "GET",
      path: "/synthetic/db",
      exposure: "public",
      contentType: "application/json",
      handler: async (c) => {
        const { rows } = await c.get("pluginDb").query("SELECT 1 AS one");
        return c.json({ rows });
      },
    });
  },
};
