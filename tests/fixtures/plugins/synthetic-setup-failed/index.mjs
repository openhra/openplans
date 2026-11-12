// Synthetic plugin fixture for the loader tests. No source data.

export default {
  manifest: {
    name: "@synthetic/setup-failed",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: [],
    capabilities: { secrets: ["SYNTHETIC_ALPHA_SECRET"] },
  },
  setup(ctx) {
    // The message carries the secret so the tests can prove it never reaches the log.
    throw new Error(`synthetic ${ctx.secrets.get("SYNTHETIC_ALPHA_SECRET")}`);
  },
};
