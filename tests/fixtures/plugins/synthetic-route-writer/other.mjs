// A synthetic plugin with a route and no pass-through source: its routes get no writer.
export default {
  manifest: {
    name: "@synthetic/route-writer-other",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["routes"],
  },
  setup(ctx) {
    ctx.routes.add({
      method: "GET",
      path: "/synthetic/route-writer-other/try",
      exposure: "public",
      contentType: "application/json",
      handler: async (c) =>
        c.json({
          result: c.get("pluginPassThroughWriter") ? "present" : "missing",
        }),
    });
  },
};
