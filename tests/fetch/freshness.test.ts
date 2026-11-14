import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Freshness from "../../src/fetch/freshness.js";
import type { FreshnessTarget } from "../../src/fetch/freshness.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
  TransportContext,
} from "../../src/fetch/index.js";
import { fetchTransient } from "../../src/fetch/index.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: vi.fn(async () => async () => {}),
}));

// Every publisher, policy and response in this suite is synthetic.
const robots = "User-agent: *\nDisallow: /private\n";
const terms = "Synthetic publisher permits automated reads.";
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
const archive = "https://publisher.test/files/plan.zip";
const index = "https://publisher.test/files/";
const held = "https://held.test/files/plan.zip";

function publisher(host: string, state: PublisherPolicy["state"]) {
  const allowed = state === "allowed";
  return {
    host,
    state,
    evidence: [
      {
        url: `https://${host}/robots.txt`,
        observedAt: new Date().toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: [`https://${host}/files/`],
    permittedPaths: ["/files/"],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Synthetic",
    delayMs: 5000,
    jobCaps: allowed
      ? { maxRequests: 8, maxTransferBytes: 1024 ** 2 }
      : { maxRequests: 1, maxTransferBytes: 1 },
    // The held entry carries a current terms review too, so only its state holds it.
    ...{
      robots: {
        url: `https://${host}/robots.txt`,
        status: 200,
        sha256: digest(robots),
        checkedAt: new Date().toISOString(),
      },
      terms: {
        url: `https://${host}/terms`,
        disposition: "allowed" as const,
        sha256: digest(terms),
        reviewedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  } as PublisherPolicy;
}

let directory: string;
let manifest: string;
let requests: { url: URL; context: TransportContext }[];
const transport: Transport = async (url, context) => {
  requests.push({ url, context });
  const policy = ({ "/robots.txt": robots, "/terms": terms } as const)[
    url.pathname as "/robots.txt" | "/terms"
  ];
  if (policy)
    return { status: 200, headers: {}, body: Readable.from([policy]) };
  if (url.pathname.endsWith(".zip"))
    return {
      status: 200,
      headers: {
        "last-modified": "Tue, 10 Nov 2026 12:00:00 GMT",
        etag: '"synthetic"',
        "content-length": "987654321",
        "content-type": "application/zip",
      },
      // A HEAD answer has no body; a body here would show the tool read one.
      body: Readable.from([]),
    };
  if (url.pathname === "/files/states/")
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      // Older years, a state the instance leaves out, the loaded files and one undated file.
      body: Readable.from([
        [
          "plan_2019_TX.zip",
          "plan_2025_TX.zip",
          "plan_2026_CA.zip",
          "plan_2026_TX.zip",
          "plan_2026_CA_dictionary.zip",
          "plan_XX_TX.zip",
        ]
          .map((name) => `<a href="${name}">${name}</a>`)
          .join(" "),
      ]),
    };
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: Readable.from([
      '<a href="plan_2026_V2.zip">a</a> <a href="plan_2027_V2.zip">b</a>',
    ]),
  };
};
const options = () => ({
  manifests: [manifest],
  dataDir: join(directory, "data"),
  lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
  transport,
});

beforeEach(async () => {
  vi.stubEnv("OPENPLANS_EGRESS_FILE", "");
  vi.stubEnv("OPENPLANS_EGRESS_SHA256", "");
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-freshness-"));
  await mkdir(join(directory, "data"));
  manifest = join(directory, "access.json");
  const content: AdmissionManifest = {
    version: 1,
    publishers: [
      publisher("publisher.test", "allowed"),
      publisher("held.test", "robots-disallowed"),
    ],
  };
  await writeFile(manifest, JSON.stringify(content));
  requests = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const targets: FreshnessTarget[] = [
  {
    family: "held",
    url: held,
    mode: "head",
    loaded: { lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" },
  },
  {
    family: "archive",
    url: archive,
    mode: "head",
    loaded: { lastModified: "Mon, 02 Nov 2026 00:00:00 GMT" },
  },
  {
    family: "listing",
    url: index,
    mode: "index",
    match: "plan_[0-9]{4}_V2\\.zip",
    loaded: { names: ["plan_2026_V2.zip"] },
  },
  {
    family: "unlisted",
    url: "https://unlisted.test/files/a.zip",
    mode: "head",
  },
  {
    family: "outside",
    url: "https://publisher.test/other/a.zip",
    mode: "head",
  },
  { family: "index-of-archive", url: archive, mode: "index" },
];

describe("publisher freshness check", () => {
  it("sends HEAD for archives, reads only index pages and never contacts a held host", async () => {
    const results = await Freshness.checkFreshness(targets, options());
    expect(results.map((r) => [r.family, r.status, r.behind])).toEqual([
      ["held", "unknown", "unknown"],
      ["archive", "checked", "yes"],
      ["listing", "checked", "yes"],
      ["unlisted", "unknown", "unknown"],
      ["outside", "unknown", "unknown"],
      ["index-of-archive", "unknown", "unknown"],
    ]);
    expect(results[0]!.reason).toMatch(/^held: robots-disallowed/);
    expect(results[3]!.reason).toMatch(/^not_admitted/);
    expect(results[4]!.reason).toMatch(/^not_admitted/);
    expect(results[5]!.reason).toMatch(/^invalid_target/);
    expect(results[1]).toMatchObject({
      lastModified: "Tue, 10 Nov 2026 12:00:00 GMT",
      contentLength: "987654321",
    });
    expect(results[2]!.names).toEqual(["plan_2026_V2.zip", "plan_2027_V2.zip"]);
    expect(requests.map(({ url }) => url.hostname)).not.toContain("held.test");
    expect(requests.map(({ url }) => url.hostname)).not.toContain(
      "unlisted.test",
    );
    const data = requests.filter(
      ({ url }) => !["/robots.txt", "/terms"].includes(url.pathname),
    );
    expect(
      data.map(({ url, context }) => [url.pathname, context.method]),
    ).toEqual([
      ["/files/plan.zip", "HEAD"],
      ["/files/", undefined],
    ]);
    // Policy reads stay GET, and nothing is cached in the data directory.
    expect(
      requests
        .filter(({ url }) => url.pathname === "/robots.txt")
        .every(({ context }) => context.method === undefined),
    ).toBe(true);
    expect(await readdir(join(directory, "data"))).toEqual([]);
  });

  it("refuses a HEAD request that would carry an upload", async () => {
    await expect(
      fetchTransient(archive, {
        ...options(),
        allowHosts: ["publisher.test"],
        headOnly: true,
        requestBody: { contentType: "text/plain", body: Buffer.from("x") },
        maxRedirects: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_options" });
    expect(requests).toEqual([]);
  });

  it("plans without network access and keeps each host under its session cap", () => {
    const publishers = Freshness.loadPublishers([manifest]);
    const many = Array.from({ length: 6 }, (_, n) => ({
      family: "archive",
      url: `https://publisher.test/files/${n}.zip`,
      mode: "head" as const,
    }));
    const plan = Freshness.planFreshness(many, publishers);
    expect(plan.filter((d) => d.action === "check")).toHaveLength(
      8 - Freshness.policyHeadroom,
    );
    expect(plan.at(-1)).toMatchObject({ reason: "over_session_cap" });
    expect(Freshness.planFreshness([targets[0]!], publishers)[0]).toMatchObject(
      { action: "skip", reason: "held" },
    );
  });

  const scoped = (names: string[]): FreshnessTarget => ({
    family: "states",
    url: "https://publisher.test/files/states/",
    mode: "index",
    match: "plan_[A-Za-z0-9_]+\\.zip",
    loaded: { names },
    served: { years: [2026], exclude: "_CA" },
  });

  it("compares only the years and scope the instance serves", async () => {
    const [current, missing, none] = await Freshness.checkFreshness(
      [
        scoped(["plan_2026_TX.zip", "plan_XX_TX.zip"]),
        scoped(["plan_2026_TX.zip"]),
        {
          ...scoped(["plan_2026_TX.zip"]),
          served: { years: [2030], exclude: "_XX_" },
        },
      ],
      options(),
    );
    // 2019, 2025 and the excluded state are listed but not compared.
    expect(current).toMatchObject({
      status: "checked",
      behind: "no",
      outOfScope: 4,
    });
    expect(current!.names).toHaveLength(6);
    // An undated name still counts, so a new file without a year is not missed.
    expect(missing!.behind).toBe("yes");
    // Nothing listed is in scope at all: the page changed shape, so the answer is unknown.
    expect(none).toMatchObject({ behind: "unknown", outOfScope: 6 });
    expect(
      Freshness.servedName(scoped([]), "cy2026-landscape-202609.zip"),
    ).toBe(true);
    expect(
      Freshness.servedName(scoped([]), "cy2025-landscape-202609.zip"),
    ).toBe(false);
  });

  it("skips a target whose name pattern is not a regular expression", () => {
    const plan = Freshness.planFreshness(
      [{ ...scoped([]), served: { exclude: "(" } }],
      Freshness.loadPublishers([manifest]),
    );
    expect(plan[0]).toMatchObject({ action: "skip", reason: "invalid_target" });
  });

  it("catches a planted mutant that compares names outside the served scope", async () => {
    const source = new URL("../../src/fetch/freshness.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "result.names.filter((name) => servedName(target, name))",
        "result.names",
      ),
      async (file) => {
        const mutant = await importMutant<typeof Freshness>(
          file,
          "checkFreshness",
        );
        const [result] = await mutant.checkFreshness(
          [scoped(["plan_2026_TX.zip", "plan_XX_TX.zip"])],
          options(),
        );
        expect(result!.behind).not.toBe("no");
      },
    );
  });

  it.each([
    [
      "plans a request to a held host",
      'if (publisher.state !== "allowed")',
      "if (false)",
    ],
    ["ignores the plan", 'if (decision.action === "skip")', "if (false)"],
  ])("catches a planted mutant that %s", async (_name, before, after) => {
    const source = new URL("../../src/fetch/freshness.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(await readFile(source, "utf8"), before, after),
      async (file) => {
        const mutant = await importMutant<typeof Freshness>(
          file,
          "planFreshness",
          "checkFreshness",
        );
        const results = await mutant.checkFreshness(targets, options());
        // Admission still refuses the held host, so the mutant never reports it as held
        // and its refusal stops the session before the admitted archive is checked.
        expect(
          results[0]!.reason?.startsWith("held: robots-disallowed") &&
            results[1]!.status === "checked",
        ).toBe(false);
        expect(requests.map(({ url }) => url.hostname)).not.toContain(
          "held.test",
        );
      },
    );
  });
});
