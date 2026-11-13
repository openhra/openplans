#!/usr/bin/env node
/** Read-only HTTPS diagnostics. Only redacted evidence is saved; root HTML stays in memory. */
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedUrl, FetchError, resolvePublic } from "../../fetch/index.js";
import { provenanceUrl, systemLookup } from "../../fetch/policy.js";
import { httpsTransport } from "../../fetch/transport.js";
import {
  cachedRegistry,
  readRegistry,
  registryWorkbook,
  verifyRegistry,
} from "./discover-registry.js";
import { qhpDataDirectory } from "./discover.js";
import { projectUrl } from "../../config/access.js";

const issuers = [
  "11718",
  "17933",
  "23018",
  "27248",
  "91476",
  "33626",
  "40220",
  "40540",
  "45786",
  "58609",
  "61315",
  "63141",
  "70754",
  "98809",
  "66252",
];
interface Hop {
  url: string;
  dns: unknown;
  address: string;
  status: number;
  headers: Record<string, string>;
  tls: { authorized: boolean; protocol: string | null };
}
interface Probe {
  requested_url: string;
  status: string;
  hops: Hop[];
  links: string[];
  dns?: unknown;
  error?: string;
  connection?: FetchError["connection"];
}

async function probe(input: string, root: boolean): Promise<Probe> {
  const result: Probe = {
    requested_url: provenanceUrl(new URL(input)),
    status: "unknown",
    hops: [],
    links: [],
  };
  const allowed = [new URL(input).hostname];
  let url = new URL(input);
  try {
    for (let redirects = 0; ; redirects++) {
      url = checkedUrl(url, allowed);
      const address = await resolvePublic(
        url,
        async (hostname) => {
          const records = await systemLookup(hostname);
          result.dns = records;
          return records;
        },
        30_000,
      );
      const project = new URL(projectUrl());
      if (
        project.protocol !== "https:" ||
        project.username ||
        project.password ||
        project.search ||
        project.hash
      )
        throw new Error("invalid identity");
      const response = await httpsTransport(url, {
        address,
        connectTimeoutMs: 30_000,
        readTimeoutMs: 30_000,
        headers: {
          "accept-encoding": "identity",
          accept: root ? "text/html" : "application/json, */*;q=0.1",
          "user-agent": `openplans/0.4.5 (public health-plan source discovery; +${project.href})`,
        },
      });
      const socket = (response.body as IncomingMessage).socket as TLSSocket;
      const headers: Record<string, string> = {};
      for (const key of [
        "server",
        "date",
        "content-type",
        "content-length",
        "retry-after",
        "x-cache",
        "cf-ray",
      ]) {
        const value = response.headers[key];
        if (value !== undefined) headers[key] = String(value).slice(0, 1024);
      }
      result.hops.push({
        url: provenanceUrl(url),
        dns: result.dns,
        address: address.address,
        status: response.status,
        headers,
        tls: { authorized: socket.authorized, protocol: socket.getProtocol() },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.body.destroy();
        if (redirects >= 5)
          throw new FetchError("too_many_redirects", "Redirect limit");
        if (!response.headers.location)
          throw new FetchError("invalid_redirect", "Missing redirect target");
        url = new URL(response.headers.location, url);
        headers.location = provenanceUrl(url);
        continue;
      }
      result.status =
        response.status === 403 ? "access_denied" : String(response.status);
      if (response.status !== 200 || !root) {
        response.body.destroy();
        break;
      }
      if (
        response.headers["content-encoding"] &&
        response.headers["content-encoding"] !== "identity"
      ) {
        response.body.destroy();
        throw new FetchError("unsupported_encoding", "Unexpected encoding");
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 ** 2) {
          response.body.destroy();
          throw new FetchError("too_large", "Root byte limit");
        }
        chunks.push(Buffer.from(chunk));
      }
      const links = new Set<string>();
      for (const match of Buffer.concat(chunks)
        .toString("utf8")
        .matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
        try {
          const link = new URL(match[1]!.replaceAll("&amp;", "&"), url);
          if (
            ["https:", "http:"].includes(link.protocol) &&
            !link.username &&
            !link.password &&
            /machine.?read|qhp|\.json(?:$|\?)|formulary|cms-data|provider.*director/i.test(
              link.href,
            )
          )
            links.add(provenanceUrl(link));
        } catch {
          /* Ignore malformed publisher links. */
        }
      }
      result.links = [...links].sort().slice(0, 100);
      break;
    }
  } catch (error) {
    result.error = error instanceof FetchError ? error.code : "network_error";
    if (error instanceof FetchError) result.connection = error.connection;
    if (result.status === "unknown") result.status = result.error;
  }
  return result;
}

const dataDir = qhpDataDirectory();
const registries = new Map<number, Awaited<ReturnType<typeof readRegistry>>>();
const registryHashes: Record<string, string> = {};
for (const year of [2026, 2027]) {
  const input = await cachedRegistry(dataDir, year);
  await verifyRegistry(input);
  registries.set(
    year,
    await readRegistry(await registryWorkbook(input, dataDir), "TX"),
  );
  registryHashes[year] = input.metadata.sha256;
}
const probes = new Map<string, Promise<Probe>>();
const getProbe = (url: string, root: boolean) => {
  const key = `${root}:${url}`;
  if (!probes.has(key)) probes.set(key, probe(url, root));
  return probes.get(key)!;
};
const findings: unknown[] = [];
// Four independent issuers at a time; each distinct URL/host root is requested once, without retries.
for (let at = 0; at < issuers.length; at += 4) {
  findings.push(
    ...(await Promise.all(
      issuers.slice(at, at + 4).map(async (issuer) => {
        const urls2026 = registries
          .get(2026)!
          .filter((row) => row.issuer === issuer)
          .map((row) => row.url);
        const urls2027 = registries
          .get(2027)!
          .filter((row) => row.issuer === issuer)
          .map((row) => row.url);
        const urls = [...new Set([...urls2026, ...urls2027].filter(Boolean))];
        const indexes = await Promise.all(
          urls.map((url) => getProbe(url, false)),
        );
        const roots = await Promise.all(
          [...new Set(urls.map((url) => new URL("/", url).href))].map((url) =>
            getProbe(url, true),
          ),
        );
        return {
          issuer,
          urls_2026: urls2026.map((url) => provenanceUrl(new URL(url))),
          urls_2027: urls2027.map((url) => provenanceUrl(new URL(url))),
          same_registry_urls:
            JSON.stringify(urls2026) === JSON.stringify(urls2027),
          indexes,
          roots,
        };
      }),
    )),
  );
}
const path = join(dataDir, "reports", "p2e-discovery-diagnosis.json");
await mkdir(join(dataDir, "reports"), { recursive: true });
await writeFile(
  path,
  `${JSON.stringify({ at: new Date().toISOString(), registry_hashes: registryHashes, findings }, null, 2)}\n`,
);
console.log(JSON.stringify({ report: path, issuers: findings.length }));
