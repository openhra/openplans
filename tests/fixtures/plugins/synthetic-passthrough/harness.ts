// Shared pieces for the synthetic pass-through tests: the synthetic publisher's admission entry
// and a transport that answers it. Synthetic host, terms and answers; no network.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
} from "../../../../src/fetch/index.js";

export const HOST = "answers.synthetic.test";
const terms = "Synthetic publisher permits request-time answers.";
const robots = "User-agent: *\nDisallow: /private\n";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function publisher(): PublisherPolicy {
  return {
    host: HOST,
    state: "allowed",
    evidence: [
      {
        url: `https://${HOST}/terms`,
        observedAt: new Date().toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: [`https://${HOST}/answers`],
    permittedPaths: ["/answers"],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    robots: {
      url: `https://${HOST}/robots.txt`,
      status: 200,
      sha256: digest(robots),
      checkedAt: new Date().toISOString(),
    },
    terms: {
      url: `https://${HOST}/terms`,
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}

/** Writes an operator manifest that admits the synthetic host and returns its path. */
export async function writeManifest(directory: string): Promise<string> {
  const path = join(directory, "access.json");
  const manifest: AdmissionManifest = { version: 1, publishers: [publisher()] };
  await writeFile(path, JSON.stringify(manifest));
  return path;
}

/**
 * A transport for the synthetic host. Each data call is pushed to `calls`. An identity that
 * starts with 2 gets no data; every other one is listed as covered.
 */
export function syntheticTransport(calls: URL[]): Transport {
  return async (url) => {
    let body = "";
    if (url.pathname === "/robots.txt") body = robots;
    else if (url.pathname === "/terms") body = terms;
    else {
      calls.push(new URL(url.href));
      body = JSON.stringify({
        answers: (url.searchParams.get("q") ?? "").split(",").map((pair) => {
          const [planId, identity] = pair.split(":");
          const question = { planId, identity, year: 2026 };
          return identity!.startsWith("2")
            ? { question, outcome: "no_data", statement: "DataNotProvided" }
            : {
                question,
                outcome: "answer",
                answer: { status: "listed_covered" },
                statement: "Covered",
              };
        }),
      });
    }
    return { status: 200, headers: {}, body: Readable.from([body]) };
  };
}
