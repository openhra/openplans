// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/registration-collision",
    version: "0.0.1",
    apiVersion: "0.2",
    kinds: ["workerCommands"],
  },
  setup(ctx) {
    ctx.workerCommands.add({
      argv: ["synthetic", "alpha"],
      usage: "worker synthetic alpha",
      run: async () => 0,
    });
  },
};
