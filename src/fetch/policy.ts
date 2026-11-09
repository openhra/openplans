import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { FetchError } from "./errors.js";

export interface Address {
  address: string;
  family: 4 | 6;
}
export type Lookup = (hostname: string) => Promise<readonly Address[]>;
export const systemLookup: Lookup = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    ({ address, family }) => ({ address, family: family as 4 | 6 }),
  );

function ipv4Number(address: string): number {
  return address
    .split(".")
    .reduce((value, part) => value * 256 + Number(part), 0);
}
function inRange(value: number, base: string, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(ipv4Number(base) / size);
}
function ipv6Number(address: string): bigint {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const colon = normalized.lastIndexOf(":");
    const v4 = ipv4Number(normalized.slice(colon + 1));
    normalized = `${normalized.slice(0, colon)}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [left = "", right = ""] = normalized.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const parts = normalized.includes("::")
    ? [
        ...head,
        ...Array<string>(8 - head.length - tail.length).fill("0"),
        ...tail,
      ]
    : head;
  return parts.reduce(
    (value, part) => (value << 16n) + BigInt(`0x${part}`),
    0n,
  );
}

/** Conservative public-unicast policy; IPv6 transition/translation ranges are denied too. */
export function isPublicAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const blocked: [string, number][] = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, prefix]) => inRange(value, base, prefix));
  }
  if (family !== 6) return false;
  const value = ipv6Number(address);
  // IPv4-mapped addresses receive the IPv4 policy, not the global IPv6 test.
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return isPublicAddress(
      [24, 16, 8, 0].map((shift) => (v4 >>> shift) & 255).join("."),
    );
  }
  if (value >> 125n !== 1n) return false; // Only 2000::/3 global unicast.
  if (value >> 105n === ipv6Number("2001::") >> 105n) return false; // Special-purpose /23.
  if (value >> 96n === 0x20010db8n || value >> 112n === 0x2002n) return false;
  if (value >> 108n === ipv6Number("3fff::") >> 108n) return false; // Documentation /20.
  return true;
}

export function checkedUrl(
  input: string | URL,
  allowHosts: readonly string[],
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchError("invalid_url", "Invalid publisher URL");
  }
  if (url.protocol !== "https:")
    throw new FetchError("https_required", "Publisher URLs must use HTTPS");
  if (url.username || url.password)
    throw new FetchError(
      "embedded_credentials",
      "URL credentials are forbidden",
    );
  if (url.port && url.port !== "443")
    throw new FetchError("blocked_port", "Only HTTPS port 443 is allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(hostname) && !isPublicAddress(hostname))
    throw new FetchError(
      "blocked_address",
      "Destination address is not public",
    );
  if (!allowHosts.some((host) => host.toLowerCase() === hostname)) {
    throw new FetchError(
      "host_not_allowed",
      "Publisher host is not allowlisted",
    );
  }
  url.hash = "";
  return url;
}

export async function resolvePublic(
  url: URL,
  resolve: Lookup,
  timeoutMs: number,
): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: readonly Address[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
      : await Promise.race([
          resolve(hostname),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new FetchError("connect_timeout", "DNS lookup timed out"),
                ),
              timeoutMs,
            );
          }),
        ]);
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError("dns_error", "Publisher DNS lookup failed");
  } finally {
    clearTimeout(timer);
  }
  if (addresses.length === 0)
    throw new FetchError("dns_error", "Publisher DNS returned no addresses");
  if (
    addresses.some(
      ({ address, family }) =>
        isIP(address) !== family || !isPublicAddress(address),
    )
  ) {
    throw new FetchError(
      "blocked_address",
      "Publisher DNS includes a non-public address",
    );
  }
  return addresses[0]!;
}

/** Never persist query values: key names are not a reliable way to identify access secrets. */
export function provenanceUrl(url: URL): string {
  const safe = new URL(url);
  // Rejected redirects can themselves contain credentials; even their evidence must be safe.
  safe.username = "";
  safe.password = "";
  for (const key of new Set(safe.searchParams.keys()))
    safe.searchParams.set(key, "[REDACTED]");
  return safe.href;
}
