// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/registration-invalid",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["routes"],
  },
  setup(ctx) {
    ctx.routes.add({
      method: "GET",
      path: "/synthetic/*",
      exposure: "public",
      contentType: "application/json",
      handler: (c) => c.json({}),
    });
  },
};
