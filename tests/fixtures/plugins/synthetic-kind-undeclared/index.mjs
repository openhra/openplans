// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/kind-undeclared",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["routes"],
  },
  setup(ctx) {
    ctx.workerCommands.add({
      argv: ["synthetic", "undeclared"],
      usage: "worker synthetic undeclared",
      run: async () => 0,
    });
  },
};
