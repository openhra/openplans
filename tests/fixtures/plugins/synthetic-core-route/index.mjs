// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/core-route",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["routes"],
  },
  setup(ctx) {
    ctx.routes.add({
      method: "GET",
      path: "/v1/plans",
      exposure: "public",
      contentType: "application/json",
      handler: (c) => c.json({}),
    });
  },
};
