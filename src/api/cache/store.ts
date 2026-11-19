export interface CacheStats {
  hits: number;
  misses: number;
  bypasses: number;
  bytes: number;
}
export type { CacheStore } from "@openplans/plugin-sdk";
import type { BoundedCacheWrite, CacheStore } from "@openplans/plugin-sdk";

export function validateMaxEntries(maxEntries: number): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0)
    throw new Error("Invalid cache entry cap");
}

export class MemoryCache implements CacheStore {
  private entries = new Map<
    string,
    {
      value: string;
      expires: number;
      size: number;
      namespace?: string;
      member?: string;
    }
  >();
  private size = 0;
  // Ordinary response entries do not need namespace indexes.
  declare private namespaces?: Map<string, Map<string, string>>;
  constructor(
    readonly maxBytes: number,
    private now = Date.now,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error("Invalid cache byte cap");
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.size -= entry.size;
      this.entries.delete(key);
      if (entry.namespace !== undefined) {
        const members = this.namespaces?.get(entry.namespace);
        members?.delete(entry.member!);
        if (!members?.size) this.namespaces?.delete(entry.namespace);
      }
    }
  }
  bytes() {
    for (const [key, entry] of this.entries)
      if (entry.expires <= this.now()) this.remove(key);
    return this.size;
  }
  /**
   * Test seam: the live keys, oldest first. Tests use it to check each cache namespace
   * separately. Request handling never calls it.
   */
  keys(): string[] {
    this.bytes();
    return [...this.entries.keys()];
  }
  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= this.now()) {
      this.remove(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.remove(key);
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (size > this.maxBytes || ttlSeconds <= 0) return;
    this.bytes();
    while (this.size + size > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
    this.entries.set(key, {
      value,
      expires: this.now() + ttlSeconds * 1000,
      size,
    });
    this.size += size;
  }
  private trimNamespace(namespace: string, maxEntries: number) {
    this.bytes();
    const members = this.namespaces?.get(namespace);
    while (members && members.size > maxEntries)
      this.remove(members.values().next().value!);
  }
  async getBounded(namespace: string, key: string, maxEntries: number) {
    validateMaxEntries(maxEntries);
    this.trimNamespace(namespace, maxEntries);
    const physical = this.namespaces?.get(namespace)?.get(key);
    return physical === undefined ? null : this.get(physical);
  }
  async setBounded(input: BoundedCacheWrite) {
    const { namespace, key, value, ttlSeconds, maxEntries } = input;
    validateMaxEntries(maxEntries);
    if (
      !Number.isFinite(ttlSeconds) ||
      Math.abs(ttlSeconds) > Number.MAX_SAFE_INTEGER / 1000
    )
      throw new Error("Invalid cache TTL");
    const physical = `openplans:bounded:v1:${JSON.stringify([namespace, key])}`;
    const size = Buffer.byteLength(physical) + Buffer.byteLength(value);
    if (size > this.maxBytes) return;
    // No await between admission and publication: all wrappers share this store's state.
    this.trimNamespace(namespace, maxEntries);
    this.remove(physical);
    if (maxEntries === 0 || ttlSeconds <= 0) return;
    while (this.size + size > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
    const members =
      this.namespaces?.get(namespace) ?? new Map<string, string>();
    members.set(key, physical);
    (this.namespaces ??= new Map()).set(namespace, members);
    this.entries.set(physical, {
      value,
      expires: this.now() + ttlSeconds * 1000,
      size,
      namespace,
      member: key,
    });
    this.size += size;
    this.trimNamespace(namespace, maxEntries);
  }
}
