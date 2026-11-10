// Fresh-install collection through the manifests shipped in data/access/. A synthetic publisher
// stands in for the network at the native transport, so the production path runs unchanged: no
// transport injection, the shipped fallback session, robots before terms before data.
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorker } from "../../src/worker/commands.js";
import {
  bootstrapPlan,
  executeBootstrap,
  parseBootstrapOptions,
} from "../../src/worker/bootstrap.js";
import { acquireGeo } from "../../src/ingest/geo/sources.js";
import { acquireBatch } from "../../src/ingest/geocode/census.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import {
  admissionManifestSchema,
  fetchToCache,
} from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  FetchResponse,
  SnapshotMetadata,
  TransportContext,
} from "../../src/fetch/index.js";
import { syntheticZip } from "../fixtures/fetch/generate.mjs";
import type * as policyModule from "../../src/fetch/policy.js";
import type * as transportModule from "../../src/fetch/transport.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { reviewProblems } from "../../scripts/check-publisher-review.mjs";

interface Served {
  status: number;
  body: Buffer | string;
  type?: string;
}
interface Request {
  url: string;
  method: string;
  body?: Buffer;
  contentType?: string;
}
const state = vi.hoisted(() => ({
  shippedPath: "",
  serve: (() => undefined) as (url: URL) => Served | undefined,
  requests: [] as Request[],
}));

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));
vi.mock("../../src/fetch/policy.js", async (original) => ({
  ...(await original<typeof policyModule>()),
  systemLookup: async () => [{ address: "8.8.8.8", family: 4 }],
}));
vi.mock("../../src/fetch/shipped.js", () => ({
  shippedManifestPaths: () =>
    process.env.OPENPLANS_SHIPPED_ACCESS === "off" ? [] : [state.shippedPath],
}));
vi.mock("../../src/fetch/transport.js", async (original) => ({
  ...(await original<typeof transportModule>()),
  httpsTransport: async (
    url: URL,
    context: TransportContext,
  ): Promise<FetchResponse> => {
    state.requests.push({
      url: url.href,
      method: context.method ?? "GET",
      body: context.body,
      contentType: context.headers["content-type"],
    });
    const served = state.serve(url) ?? { status: 404, body: "" };
    return {
      status: served.status,
      headers: served.type ? { "content-type": served.type } : {},
      body: Readable.from([Buffer.from(served.body)]),
    };
  },
}));

const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const shipped = fileURLToPath(
  new URL("../../data/access/federal-publishers.json", import.meta.url),
);
const pufFixtures = fileURLToPath(
  new URL("../fixtures/puf/import/", import.meta.url),
);
const geoFixtures = fileURLToPath(new URL("../fixtures/geo/", import.meta.url));
const cmsTerms =
  "https://www.cms.gov/files/document/exchange-pufs-disclaimagree-py27.pdf";
const syntheticTerms = (url: string) =>
  `Synthetic stand-in for the reviewed terms document ${url}`;
const landing =
  "https://www.cms.gov/marketplace/resources/data/public-use-files";
const pufUrl = (kind: string) =>
  `https://download.cms.gov/marketplace-puf/2026/${kind}-puf.zip`;
const relationshipUrl =
  "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt";
const centroidUrl =
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2021_Gazetteer/2021_Gaz_zcta_national.zip";
const txRatingUrl =
  "https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/tx-gra";
const robots: Record<string, Served> = {
  "www.cms.gov": {
    status: 200,
    body: "User-agent: *\nDisallow: /core/\nDisallow: /node/\nDisallow: /*?\n",
    type: "text/plain",
  },
  "download.cms.gov": { status: 404, body: "" },
  "www2.census.gov": {
    status: 200,
    body: "User-agent: Googlebot\nCrawl-delay: 30\n",
    type: "text/plain",
  },
  "www.usa.gov": {
    status: 200,
    body: "User-agent: *\nCrawl-delay: 10\n",
    type: "text/plain",
  },
  "geocoding.geo.census.gov": {
    status: 404,
    body: "<html>Not Found</html>",
    type: "text/html",
  },
};
let terms: Record<string, string>;
let data: Map<string, Served>;
let directory: string;

/**
 * The shipped manifest with only each terms hash replaced by the hash of a synthetic stand-in, since
 * the publisher's real terms bytes are not committed. Hosts, paths, robots evidence, pacing and caps
 * are the shipped values, and the test checks nothing else differs.
 */
async function derivedShippedManifest(): Promise<AdmissionManifest> {
  const manifest = admissionManifestSchema.parse(
    JSON.parse(await readFile(shipped, "utf8")),
  );
  terms = {};
  for (const publisher of manifest.publishers)
    if (publisher.terms) {
      terms[publisher.terms.url] = syntheticTerms(publisher.terms.url);
      publisher.terms.sha256 = sha(terms[publisher.terms.url]!);
    }
  return manifest;
}
async function writeShipped(manifest: AdmissionManifest) {
  await writeFile(state.shippedPath, JSON.stringify(manifest));
}
function pufLandingHtml(): string {
  const links = IMPORT_KINDS.map(
    (kind) => `<li><a href="${pufUrl(kind)}">${kind} PUF</a></li>`,
  ).join("");
  return `<html><body><h2>2026 Exchange PUF Datasets</h2><ul>${links}</ul></body></html>`;
}
async function publisherData(): Promise<Map<string, Served>> {
  const served = new Map<string, Served>();
  served.set(landing, {
    status: 200,
    body: pufLandingHtml(),
    type: "text/html",
  });
  for (const kind of IMPORT_KINDS)
    served.set(pufUrl(kind), {
      status: 200,
      type: "application/zip",
      body: syntheticZip([
        {
          name: `${kind}.csv`,
          body: await readFile(join(pufFixtures, `${kind}.csv`), "utf8"),
        },
      ]),
    });
  served.set(relationshipUrl, {
    status: 200,
    type: "text/plain",
    body: await readFile(join(geoFixtures, "zcta-county-tx.psv")),
  });
  served.set(centroidUrl, {
    status: 200,
    type: "application/zip",
    body: syntheticZip([
      {
        name: "2021_Gaz_zcta_national.txt",
        body: await readFile(
          join(geoFixtures, "zcta-centroids-tx.tsv"),
          "utf8",
        ),
      },
    ]),
  });
  served.set(txRatingUrl, {
    status: 200,
    type: "text/html",
    body: await readFile(join(geoFixtures, "tx-rating-areas.html")),
  });
  return served;
}
const output = () => {
  const lines: string[] = [];
  return {
    lines,
    out: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
};
const dataRequests = () =>
  state.requests.filter(
    (request) => !request.url.endsWith("/robots.txt") && !terms[request.url],
  );

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-fresh-"));
  state.shippedPath = join(directory, "shipped-derived.json");
  await writeShipped(await derivedShippedManifest());
  data = await publisherData();
  state.requests = [];
  state.serve = (url) => {
    if (url.pathname === "/robots.txt") return robots[url.hostname];
    if (terms[url.href])
      return { status: 200, body: terms[url.href]!, type: "text/html" };
    return data.get(url.href);
  };
  vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", "");
  vi.stubEnv("OPENPLANS_SHIPPED_ACCESS", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("shipped federal publisher manifests", () => {
  it("derives the test manifest from the shipped one by terms hashes only", async () => {
    const original = admissionManifestSchema.parse(
      JSON.parse(await readFile(shipped, "utf8")),
    );
    const derived = JSON.parse(await readFile(state.shippedPath, "utf8"));
    for (const publisher of derived.publishers)
      if (publisher.terms)
        publisher.terms.sha256 = original.publishers.find(
          (entry) => entry.host === publisher.host,
        )!.terms!.sha256;
    expect(derived).toEqual(original);
  });

  it("admits exactly the matching PY2025 CMS paths with the existing review and pacing", async () => {
    const manifest = admissionManifestSchema.parse(
      JSON.parse(await readFile(shipped, "utf8")),
    );
    const publisher = manifest.publishers.find(
      (p) => p.host === "download.cms.gov",
    )!;
    const paths = (year: number) =>
      publisher.permittedPaths.filter((path) =>
        path.startsWith(`/marketplace-puf/${year}/`),
      );
    expect(paths(2025)).toHaveLength(8);
    expect(paths(2025)).toEqual(
      paths(2026).map((path) => path.replace("/2026/", "/2025/")),
    );
    expect(paths(2025)).toEqual(
      paths(2027).map((path) => path.replace("/2027/", "/2025/")),
    );
    expect(publisher.scope.years).toEqual([2025, 2026, 2027]);
    expect(publisher.delayMs).toBe(5000);
    expect(publisher.jobCaps).toEqual({
      maxRequests: 20,
      maxTransferBytes: 2147483648,
    });
    expect(publisher.robots).toMatchObject({
      status: 404,
      sha256: null,
      country: "CO",
    });
    expect(publisher.terms).toMatchObject({
      url: cmsTerms,
      disposition: "allowed",
      reviewer: "OpenPlans maintainers",
    });
    for (const path of paths(2025)) {
      const url = `https://download.cms.gov${path}`;
      data.set(url, {
        status: 200,
        body: `synthetic PY2025 path probe ${path}`,
        type: "application/octet-stream",
      });
      const fetched = await fetchToCache(url, {
        source: "synthetic-py2025",
        allowHosts: ["download.cms.gov"],
        expectedContent: "binary",
        dataDir: directory,
      });
      expect(fetched).toMatchObject({ metadata: { url } });
    }
  });

  it.each([
    "/marketplace-puf/2024/rate-puf.zip",
    "/marketplace-puf/2028/rate-puf.zip",
    "/marketplace-puf/2025/unreviewed.zip",
    "/marketplace-puf/2025-other/rate-puf.zip",
  ])("negative control: PY2025 admission does not clear %s", async (path) => {
    await expect(
      fetchToCache(`https://download.cms.gov${path}`, {
        source: "synthetic-unreviewed",
        allowHosts: ["download.cms.gov"],
        expectedContent: "binary",
        dataDir: directory,
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
    expect(state.requests).toEqual([]);
  });

  it("bootstraps a fresh install with an empty cache through the shipped manifests alone", async () => {
    const pg = new PGlite(),
      db = testDatabase(pg),
      core = await coreMigrations();
    try {
      const cache = join(directory, "data");
      await mkdir(cache);
      vi.stubEnv("OPENPLANS_DATA_DIR", cache);
      const out = output();
      const code = await runWorker(
        ["bootstrap", "--states", "TX", "--years", "2026"],
        () => ({ ...db, close: async () => {} }),
        out,
        core.directory,
      );
      const summary = JSON.parse(out.lines.at(-1)!);
      expect(summary).toMatchObject({ passed: true, failed: [], blocked: [] });
      expect(code).toBe(0);
      const ids = summary.steps.map((step: { id: string }) => step.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          "puf-acquire-2026",
          "puf-TX-2026",
          "geo-TX-2026",
        ]),
      );
      // Every data request is a shipped, permitted path, and each host's robots came first.
      const fetched = dataRequests().map((request) => request.url);
      expect(fetched).toEqual(
        expect.arrayContaining([
          landing,
          ...IMPORT_KINDS.map(pufUrl),
          relationshipUrl,
          centroidUrl,
          txRatingUrl,
        ]),
      );
      for (const url of fetched) {
        const host = new URL(url).hostname;
        const first = state.requests.findIndex(
          (request) => new URL(request.url).hostname === host,
        );
        expect(state.requests[first]!.url).toBe(`https://${host}/robots.txt`);
      }
      // Snapshots carry the shipped session's receipt.
      const rating = JSON.parse(
        await readFile(
          join(
            cache,
            "raw",
            "cms-rating-areas",
            `${sha(data.get(txRatingUrl)!.body)}.meta.json`,
          ),
          "utf8",
        ),
      ) as SnapshotMetadata;
      expect(rating.access_policy?.hosts[0]).toMatchObject({
        host: "www.cms.gov",
        state: "allowed",
        termsUrl: cmsTerms,
      });
      expect(
        (await db.query("SELECT state FROM puf_active_catalog")).rows,
      ).toEqual([{ state: "TX" }]);
      expect((await db.query("SELECT state FROM geo_import")).rows).toEqual([
        { state: "TX" },
      ]);
    } finally {
      await db.close();
      await core.cleanup();
    }
  });

  it("refuses a path outside the shipped manifest before any request", async () => {
    data.set("https://www.cms.gov/files/zip/unreviewed.zip", {
      status: 200,
      body: "synthetic",
    });
    await expect(
      fetchToCache("https://www.cms.gov/files/zip/unreviewed.zip", {
        source: "synthetic-unreviewed",
        allowHosts: ["www.cms.gov"],
        expectedContent: "binary",
        dataDir: directory,
      }),
    ).rejects.toMatchObject({
      code: "admission_denied",
      message: expect.stringContaining(
        "outside the publisher's reviewed permitted paths",
      ),
    });
    expect(state.requests).toEqual([]);
  });

  it("refuses an unshipped host and every held host with zero requests", async () => {
    for (const url of [
      "https://issuer.example/qhp/index.json",
      "https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_11022026.zip",
      "https://download.geonames.org/export/zip/US.zip",
      "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv",
    ])
      await expect(
        fetchToCache(url, {
          source: "synthetic-held",
          allowHosts: [new URL(url).hostname],
          expectedContent: "binary",
          dataDir: directory,
        }),
      ).rejects.toMatchObject({ code: "admission_denied" });
    expect(state.requests).toEqual([]);
  });

  it("obeys a robots Disallow over the shipped manifest", async () => {
    robots["www2.census.gov"] = {
      status: 200,
      body: "User-agent: *\nDisallow: /geo/\n",
      type: "text/plain",
    };
    try {
      await expect(
        acquireGeo({ dataDir: directory, state: "TX" }),
      ).rejects.toMatchObject({ code: "admission_denied" });
      expect(dataRequests()).toEqual([]);
    } finally {
      robots["www2.census.gov"] = {
        status: 200,
        body: "User-agent: Googlebot\nCrawl-delay: 30\n",
        type: "text/plain",
      };
    }
  });

  it("stops collection when a shipped host's terms changed", async () => {
    terms[cmsTerms] = "Synthetic changed terms forbid automated downloads.";
    await expect(
      fetchToCache(pufUrl("rate"), {
        source: "cms-exchange-puf",
        allowHosts: ["download.cms.gov"],
        expectedContent: "zip",
        dataDir: directory,
      }),
    ).rejects.toMatchObject({
      code: "admission_denied",
      message: "Publisher terms changed or are unavailable",
    });
    expect(dataRequests()).toEqual([]);
  });

  it("an operator manifest re-reviews a shipped host and adds another", async () => {
    const operator = join(directory, "operator.json");
    const derived = await derivedShippedManifest();
    const nucc = derived.publishers.find(
      (entry) => entry.host === "www.nucc.org",
    )!;
    await writeShipped(derived);
    await writeFile(
      operator,
      JSON.stringify({
        version: 1,
        publishers: [
          {
            ...nucc,
            state: "allowed",
            robots: {
              url: "https://www.nucc.org/robots.txt",
              status: 200,
              sha256: sha("User-agent: *\nAllow: /\n"),
              checkedAt: new Date().toISOString(),
            },
            jobCaps: { maxRequests: 5, maxTransferBytes: 1024 ** 2 },
            terms: {
              url: "https://www.nucc.org/terms",
              disposition: "allowed",
              sha256: sha("Synthetic operator-reviewed terms"),
              reviewedAt: new Date(Date.now() - 1000).toISOString(),
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          },
        ],
      }),
    );
    vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", operator);
    robots["www.nucc.org"] = { status: 200, body: "User-agent: *\nAllow: /\n" };
    terms["https://www.nucc.org/terms"] = "Synthetic operator-reviewed terms";
    const csv = "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv";
    data.set(csv, { status: 200, body: "Code,Grouping\n", type: "text/csv" });
    try {
      const result = await fetchToCache(csv, {
        source: "synthetic-nucc",
        allowHosts: ["www.nucc.org"],
        expectedContent: "csv",
        dataDir: directory,
      });
      expect(result.admission?.hosts[0]).toMatchObject({
        host: "www.nucc.org",
      });
    } finally {
      delete robots["www.nucc.org"];
    }
  });
});

describe("Census geocoder admission", () => {
  const csv = "1,901 Bagby St,Houston,TX,77002\n";
  const endpoint =
    "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";

  it("refuses the geocoder without admission, before any request", async () => {
    vi.stubEnv("OPENPLANS_SHIPPED_ACCESS", "off");
    await expect(
      acquireBatch(csv, { dataDir: directory }),
    ).rejects.toMatchObject({ code: "admission_required" });
    expect(state.requests).toEqual([]);
  });

  it("posts the batch through the shipped session: robots and terms as GET, data as POST", async () => {
    data.set(endpoint, {
      status: 200,
      body: '"1","901 Bagby St, Houston, TX, 77002","No_Match"\n',
      type: "text/csv",
    });
    const result = await acquireBatch(csv, { dataDir: directory });
    expect(result.requests).toBe(1);
    expect(
      state.requests.map((request) => [
        request.method,
        new URL(request.url).pathname,
      ]),
    ).toEqual([
      ["GET", "/robots.txt"],
      ["GET", "/geocoder/Geocoding_Services_API.html"],
      ["POST", "/geocoder/locations/addressbatch"],
    ]);
    const post = state.requests.at(-1)!;
    expect(post.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(post.body?.toString()).toContain(csv);
    expect(result.file.metadata.access_policy?.hosts[0]).toMatchObject({
      host: "geocoding.geo.census.gov",
      robots: { status: 404, absent: true },
      egressCountry: null,
    });
  });
});

describe("bootstrap failure detail", () => {
  it("shows admission_required and its message in the step and the last JSON line", async () => {
    vi.stubEnv("OPENPLANS_SHIPPED_ACCESS", "off");
    const pg = new PGlite(),
      db = testDatabase(pg),
      core = await coreMigrations();
    try {
      const cache = join(directory, "data");
      await mkdir(cache);
      vi.stubEnv("OPENPLANS_DATA_DIR", cache);
      const out = output();
      const code = await runWorker(
        ["bootstrap", "--states", "TX", "--years", "2026"],
        () => ({ ...db, close: async () => {} }),
        out,
        core.directory,
      );
      expect(code).toBe(1);
      const summary = JSON.parse(out.lines.at(-1)!);
      const geo = summary.steps.find(
        (step: { id: string }) => step.id === "geo-TX-2026",
      );
      expect(geo).toMatchObject({
        status: "failed",
        reason: "admission_required",
        error: {
          code: "admission_required",
          message: "Native collection requires a reviewed publisher manifest",
        },
        action: expect.stringContaining("docs/self-host.md#publisher-access"),
      });
      expect(state.requests).toEqual([]);
    } finally {
      await db.close();
      await core.cleanup();
    }
  });

  it("refuses a quarantined cached release page without a readmission in verifiedCached", async () => {
    const pg = new PGlite(),
      db = testDatabase(pg),
      core = await coreMigrations();
    try {
      const source = join(directory, "raw", "nlm-rxnorm-files");
      const page = Buffer.from(
        '<a href="https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_11022026.zip">synthetic</a>',
      );
      const id = sha(page);
      await mkdir(join(source, id), { recursive: true });
      await writeFile(join(source, id, "payload"), page);
      const metadata = {
        snapshot_id: id,
        source: "nlm-rxnorm-files",
        url: "https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html",
        sha256: id,
        bytes: page.length,
        fetched_at: "2026-11-07T00:00:00Z",
      };
      await writeFile(
        join(source, `${id}.meta.json`),
        JSON.stringify(metadata),
      );
      await writeFile(
        join(source, "QUARANTINE.json"),
        JSON.stringify({ snapshots: [id] }),
      );
      const plan = (
        await bootstrapPlan(
          parseBootstrapOptions([
            "--states",
            "TX",
            "--years",
            "2026",
            "--with-drugs",
          ]),
          () => db,
          directory,
          core.directory,
        )
      ).filter((step) => ["migrate", "rxnorm"].includes(step.id));
      const result = await executeBootstrap(plan, output());
      expect(result.steps.find((step) => step.id === "rxnorm")).toMatchObject({
        status: "failed",
        error: {
          code: "admission_denied",
          message: "Snapshot quarantined pending admission",
        },
      });
      expect(state.requests).toEqual([]);
    } finally {
      await db.close();
      await core.cleanup();
    }
  });
});

describe("shipped manifest release check", () => {
  const policy = {
    reviewer: "OpenPlans maintainers",
    maxAgeDays: 90,
    previousRelease: { version: "v0.1.2", publishedAt: "2026-11-09T04:47:48Z" },
  };
  const at = (iso: string) => new Date(iso);
  it("passes the shipped manifests now and fails them once stale", async () => {
    const manifest = JSON.parse(await readFile(shipped, "utf8"));
    const real = JSON.parse(
      await readFile(join(shipped, "..", "review-policy.json"), "utf8"),
    );
    expect(reviewProblems(manifest, real, at("2026-11-10T12:00:00Z"))).toEqual(
      [],
    );
    expect(
      reviewProblems(manifest, policy, at("2027-02-15T00:00:00Z")).join("\n"),
    ).toContain("older than 90 days");
    expect(
      reviewProblems(
        manifest,
        {
          ...policy,
          previousRelease: {
            version: "v9",
            publishedAt: "2026-12-01T00:00:00Z",
          },
        },
        at("2026-12-02T00:00:00Z"),
      ).join("\n"),
    ).toContain("older than the previous release (v9)");
  });
  it("fails a cleared host without reviewer or quoted basis", async () => {
    const manifest = JSON.parse(await readFile(shipped, "utf8"));
    delete manifest.publishers[0].terms.reviewer;
    manifest.publishers[1].terms.basis = "unquoted";
    const problems = reviewProblems(
      manifest,
      policy,
      at("2026-11-10T12:00:00Z"),
    );
    expect(problems).toEqual([
      "www.cms.gov: terms reviewer must be OpenPlans maintainers",
      "download.cms.gov: terms basis must quote the publisher text",
    ]);
  });
});
