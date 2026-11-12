// Synthetic plugin fixture: a third cache store for the provider tests. No source data.

const state = (globalThis.syntheticCacheStore ??= { down: false, created: 0 });

class SyntheticStore {
  entries = new Map();
  transferred = 0;
  check() {
    if (state.down) throw new Error("Synthetic store unavailable");
  }
  bytes() {
    return this.transferred;
  }
  async get(key) {
    this.check();
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= Date.now()) return null;
    this.transferred += Buffer.byteLength(entry.value);
    return entry.value;
  }
  async set(key, value, ttlSeconds) {
    this.check();
    if (Buffer.byteLength(value) > 2 * 1024 * 1024) return;
    this.entries.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
    this.transferred += Buffer.byteLength(value);
  }
}

export default {
  manifest: {
    name: "@synthetic/cache-store",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["cacheStores"],
  },
  setup(ctx) {
    ctx.cacheStores.provide("synthetic", () => {
      state.created += 1;
      return new SyntheticStore();
    });
  },
};
