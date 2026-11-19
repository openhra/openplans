import { createHash } from "node:crypto";
import type { BoundedCacheWrite } from "@openplans/plugin-sdk";
import { validateMaxEntries } from "./store.js";
import { createConnection } from "node:net";
import type { CacheStore } from "./store.js";

export const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
export const CACHE_URL_MESSAGE =
  "Cache URL must be redis://host:port without credentials or a database";

/**
 * One hash owns values and their index, so allkeys eviction cannot orphan answers. The index
 * has at most 4096 members and the namespace at most 8 MiB of payload. These extra provider
 * limits bound script work even when a source declares a larger cap. TIME uses the server clock.
 * Only metadata crosses Lua for expiry/eviction; reads return one answer, never the whole hash.
 */
function boundedScript() {
  return `
local bucket = KEYS[1]
local member = ARGV[2]
local cap = math.min(tonumber(ARGV[3]), 4096)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = tonumber(ARGV[5])
if ARGV[1] == 'set' and (not ttl or ttl + now > 9007199254740991) then
  return redis.error_reply('Invalid cache TTL')
end
local raw = redis.call('HGET', bucket, 'index')
if not raw and redis.call('HLEN', bucket) > 0 then
  return redis.error_reply('Invalid cache index')
end
local index = raw and cjson.decode(raw) or {}
if #index > 4096 then return redis.error_reply('Invalid cache index') end
local live, removed, bytes = {}, {}, 0
for _, entry in ipairs(index) do
  if entry[2] <= now or (ARGV[1] == 'set' and entry[1] == member) then
    table.insert(removed, entry[1])
  else
    table.insert(live, entry)
    bytes = bytes + entry[3]
  end
end
if ARGV[1] == 'set' and ttl > 0 and cap > 0 then
  local size = string.len(ARGV[4])
  table.insert(live, {member, now + ttl, size})
  bytes = bytes + size
end
local first = 1
while (#live - first + 1) > cap or bytes > 8388608 do
  table.insert(removed, live[first][1])
  bytes = bytes - live[first][3]
  first = first + 1
end
local kept, latest, present = {}, 0, false
for i = first, #live do
  local entry = live[i]
  table.insert(kept, entry)
  latest = math.max(latest, entry[2])
  if entry[1] == member then present = true end
end
if #kept == 0 then
  redis.call('DEL', bucket)
else
  local encoded = cjson.encode(kept)
  if ARGV[1] == 'set' and present then
    redis.call('HSET', bucket, 'index', encoded, member, ARGV[4])
  else
    redis.call('HSET', bucket, 'index', encoded)
  end
  for _, key in ipairs(removed) do
    if key ~= member or not present then redis.call('HDEL', bucket, key) end
  end
  redis.call('PEXPIREAT', bucket, latest)
end
if ARGV[1] == 'set' then return 'OK' end
if present then return redis.call('HGET', bucket, member) end
return false
`;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** One bounded, deadline-limited connection per command; no reconnect queue or idle sockets. */
export class RespCache implements CacheStore {
  private host: string;
  private port: number;
  private transferred = 0;
  constructor(
    address: string,
    private timeoutMs = 150,
  ) {
    const url = new URL(address);
    if (
      url.protocol !== "redis:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    ) {
      throw new Error(CACHE_URL_MESSAGE);
    }
    this.host = url.hostname.replace(/^\[|\]$/g, "");
    this.port = Number(url.port || 6379);
  }
  bytes() {
    return this.transferred;
  }
  private command(parts: string[]): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0),
        done = false;
      const finish = (error?: Error, value: string | null = null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(
        () => finish(new Error("Cache deadline exceeded")),
        this.timeoutMs,
      );
      socket.on("error", () => finish(new Error("Cache unavailable")));
      socket.on("end", () => finish(new Error("Cache closed before reply")));
      socket.on("connect", () =>
        socket.write(
          `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("")}`,
        ),
      );
      socket.on("data", (chunk) => {
        if (buffer.length + chunk.length > MAX_ENTRY_BYTES + 128)
          return finish(new Error("Cache reply too large"));
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const prefix = buffer[0],
          line = buffer.subarray(1, end).toString();
        if (prefix === 43 && line === "OK") return finish(undefined, "OK");
        if (prefix !== 36 || !/^-?\d+$/.test(line))
          return finish(new Error("Invalid cache reply"));
        const length = Number(line);
        if (length === -1) return finish();
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_ENTRY_BYTES
        )
          return finish(new Error("Invalid cache length"));
        if (buffer.length < end + 2 + length + 2) return;
        if (
          buffer.toString("ascii", end + 2 + length, end + 4 + length) !==
          "\r\n"
        )
          return finish(new Error("Invalid cache terminator"));
        finish(
          undefined,
          buffer.subarray(end + 2, end + 2 + length).toString(),
        );
      });
    });
  }
  async get(key: string) {
    const value = await this.command(["GET", key]);
    if (value !== null) this.transferred += Buffer.byteLength(value);
    return value;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if (Buffer.byteLength(value) > MAX_ENTRY_BYTES) return;
    if (
      (await this.command(["SET", key, value, "EX", String(ttlSeconds)])) !==
      "OK"
    )
      throw new Error("Cache write rejected");
    this.transferred += Buffer.byteLength(value);
  }
  private async bounded(
    namespace: string,
    key: string,
    maxEntries: number,
    value?: string,
    ttlSeconds = 0,
  ) {
    validateMaxEntries(maxEntries);
    if (
      !Number.isFinite(ttlSeconds) ||
      Math.abs(ttlSeconds) > Number.MAX_SAFE_INTEGER / 1000
    )
      throw new Error("Invalid cache TTL");
    if (value !== undefined && Buffer.byteLength(value) > MAX_ENTRY_BYTES)
      return null;
    const result = await this.command([
      "EVAL",
      boundedScript(),
      "1",
      `openplans:bounded:v1:${hash(namespace)}`,
      value === undefined ? "get" : "set",
      `v:${hash(key)}`,
      String(maxEntries),
      value ?? "",
      String(Math.ceil(ttlSeconds * 1000)),
    ]);
    if (value !== undefined) {
      if (result !== "OK") throw new Error("Cache write rejected");
      this.transferred += Buffer.byteLength(value);
    } else if (result !== null) this.transferred += Buffer.byteLength(result);
    return result;
  }
  getBounded(namespace: string, key: string, maxEntries: number) {
    return this.bounded(namespace, key, maxEntries);
  }
  async setBounded(input: BoundedCacheWrite) {
    await this.bounded(
      input.namespace,
      input.key,
      input.maxEntries,
      input.value,
      input.ttlSeconds,
    );
  }
}
