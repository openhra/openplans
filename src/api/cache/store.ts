export interface CacheStats { hits: number; misses: number; bypasses: number; bytes: number }
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Resident key/value bytes for LRU; cumulative payload transfer bytes for RESP. */
  bytes(): number;
}

export class MemoryCache implements CacheStore {
  private entries = new Map<string, { value: string; expires: number; size: number }>();
  private size = 0;
  constructor(readonly maxBytes: number, private now = Date.now) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid cache byte cap');
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) { this.size -= entry.size; this.entries.delete(key); }
  }
  bytes() {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.remove(key);
    return this.size;
  }
  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= this.now()) { this.remove(key); return null; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.remove(key);
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (size > this.maxBytes || ttlSeconds <= 0) return;
    this.bytes();
    while (this.size + size > this.maxBytes) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { value, expires: this.now() + ttlSeconds * 1000, size }); this.size += size;
  }
}
