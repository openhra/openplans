// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/route-collision",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["routes"],
  },
  setup(ctx) {
    ctx.routes.add({
      method: "GET",
      path: "/alpha",
      exposure: "public",
      contentType: "application/json",
      handler: (c) => c.json({}),
    });
  },
};
