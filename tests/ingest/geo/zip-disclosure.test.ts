import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Transport } from "../../../src/fetch/index.js";
import {
  upstreamSources,
  withUpstreamDisclosure,
} from "../../../src/plugins/upstream-scope.js";
import * as cms from "../../../src/ingest/geo/cms.js";
import { fixtureDirectory } from "./helpers.js";
import { migratedTemplate } from "../../pglite.js";
import { importMutant, plantMutantFile } from "../../mutant-file.js";
import { replaceSyntax } from "../../source-mutation.js";

// The ZIP fallback's CMS consultations are disclosed in `x-openplans-upstream`, like every
// pass-through source. Fixtures are synthetic.
const KEY = "synthetic-cms-test-credential";
const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const source = new URL("../../../src/ingest/geo/cms.ts", import.meta.url);
let template: Awaited<ReturnType<typeof migratedTemplate>>;
let directory: string;
let body: string;

beforeAll(async () => {
  template = await migratedTemplate();
  directory = await mkdtemp(join(tmpdir(), "openplans-zip-disclose-"));
  body = await readFile(
    join(fixtureDirectory, "cms-77001.synthetic.json"),
    "utf8",
  );
}, 30_000);
afterAll(async () => {
  await template.close();
  await rm(directory, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());

const ok = (status: number, text: string) => ({
  status,
  headers: { "content-type": "application/json" },
  body: Readable.from([text]),
});

async function consult(
  module: typeof cms,
  status: number,
  options: { declined?: boolean; second?: boolean } = {},
) {
  vi.stubEnv("CMS_API_KEY", KEY);
  const db = await template.fresh();
  const transport = vi.fn<Transport>(async () =>
    ok(status, status === 200 ? body : "{}"),
  );
  const opts = {
    year: 2026,
    dataDir: join(directory, `d${status}${options.declined ? "x" : ""}`),
    fetchOptions: { lookup, transport },
  };
  const sources: string[][] = [];
  await withUpstreamDisclosure(async () => {
    await module.cmsCountySnapshot(db, "77001", opts);
    sources.push(upstreamSources());
  }, options.declined);
  if (options.second)
    await withUpstreamDisclosure(async () => {
      await module.cmsCountySnapshot(db, "77001", opts);
      sources.push(upstreamSources());
    }, options.declined);
  return { sources, calls: transport.mock.calls.length };
}

describe("ZIP fallback disclosure", () => {
  it("names the CMS source after a live consultation and again when a stored answer serves", async () => {
    const live = await consult(cms, 200, { second: true });
    expect(live.calls).toBe(1);
    expect(live.sources).toEqual([
      ["cms-marketplace-api"],
      ["cms-marketplace-api"],
    ]);
  });

  it("names the source when the upstream refuses the call", async () => {
    const refused = await consult(cms, 403);
    expect(refused.calls).toBe(1);
    expect(refused.sources).toEqual([["cms-marketplace-api"]]);
  });

  it("passthrough=off asks nothing and discloses nothing", async () => {
    const off = await consult(cms, 200, { declined: true });
    expect(off.calls).toBe(0);
    expect(off.sources).toEqual([[]]);
  });

  it("kills: a ZIP fallback call that is not disclosed", async () => {
    const text = await readFile(source, "utf8");
    const planted = await plantMutantFile(
      source,
      replaceSyntax(
        replaceSyntax(
          text,
          "recordUpstream([CMS_API_SOURCE]);\n  const safeUrl",
          "const safeUrl",
        ),
        "    recordUpstream([CMS_API_SOURCE]);\n    return cached.snapshot_id;",
        "    return cached.snapshot_id;",
      ),
    );
    try {
      const mutant = await importMutant<typeof cms>(
        planted.url,
        "cmsCountySnapshot",
      );
      const result = await consult(mutant, 200, { second: true });
      expect(result.calls).toBe(1);
      expect(result.sources).toEqual([[], []]);
      expect(result.sources).not.toEqual([
        ["cms-marketplace-api"],
        ["cms-marketplace-api"],
      ]);
    } finally {
      await planted.cleanup();
    }
  });
});
