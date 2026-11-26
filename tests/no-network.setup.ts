import net from "node:net";
import { afterAll, afterEach, expect } from "vitest";

// No test reads the network. Any connection to a host that is not loopback fails the running test,
// naming the test and the host, even when the code under test catches the error it is thrown into.
// Tests inject a transport (see FetchOptions.transport) or a local server instead.

// Shared through globalThis so the guard's own test can take the refusals it provokes on purpose.
const guard = globalThis as { __networkRefusals?: string[] };
const violations: string[] = (guard.__networkRefusals ??= []);

export function isLoopbackHost(host: unknown): boolean {
  if (host === undefined || host === null || host === "") return true;
  if (typeof host !== "string") return false;
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "::1" ||
    name === "0:0:0:0:0:0:0:1" ||
    /^127(\.\d{1,3}){3}$/.test(name) ||
    name === "::ffff:127.0.0.1"
  );
}

function blocked(host: string, port: unknown): Error {
  const test = expect.getState().currentTestName ?? "(outside a test)";
  const message = `test "${test}" tried a network connection to ${host}${port ? `:${String(port)}` : ""}; tests make no network reads, inject a transport or use a loopback server`;
  violations.push(message);
  return new Error(message);
}

function target(args: unknown[]): {
  host: unknown;
  port: unknown;
  ipc: boolean;
} {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    const o = first as { host?: unknown; port?: unknown; path?: unknown };
    return { host: o.host, port: o.port, ipc: typeof o.path === "string" };
  }
  if (typeof first === "string" && Number.isNaN(Number(first)))
    return { host: undefined, port: undefined, ipc: true };
  return {
    host: typeof args[1] === "string" ? args[1] : undefined,
    port: first,
    ipc: false,
  };
}

type Lookup = (
  hostname: string,
  options: unknown,
  callback: (error: unknown, address?: unknown, family?: number) => void,
) => void;

// A connect that names a host and brings its own `lookup` (a pinned address) is judged by the
// address that lookup returns, not by the name.
function checked(lookup: Lookup, host: string, port: unknown): Lookup {
  return (hostname, options, callback) =>
    lookup(hostname, options, (error, address, family) => {
      if (!error) {
        const list = Array.isArray(address) ? address : [address];
        for (const entry of list) {
          const ip =
            typeof entry === "string"
              ? entry
              : (entry as { address?: string })?.address;
          if (!isLoopbackHost(ip))
            return callback(blocked(`${host} (${String(ip)})`, port));
        }
      }
      callback(error, address, family);
    });
}

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const { host, port, ipc } = target(args);
  if (!ipc && !isLoopbackHost(host)) {
    const first = args[0] as { lookup?: Lookup } | undefined;
    if (typeof host === "string" && typeof first?.lookup === "function") {
      args[0] = { ...first, lookup: checked(first.lookup, host, port) };
    } else {
      const error = blocked(String(host), port);
      queueMicrotask(() => this.destroy(error));
      return this;
    }
  }
  return (original as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const realFetch = globalThis.fetch;
globalThis.fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const raw =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
  let host: string | undefined;
  try {
    host = new URL(raw).hostname;
  } catch {
    // A relative or malformed URL reaches the real fetch, which rejects it.
  }
  if (host !== undefined && !isLoopbackHost(host))
    return Promise.reject(blocked(host, undefined));
  return realFetch(input, init);
}) as typeof fetch;

function fail(): void {
  if (violations.length === 0) return;
  const found = violations.splice(0);
  throw new Error(`network guard: ${found.join("; ")}`);
}
afterEach(fail);
afterAll(fail);
