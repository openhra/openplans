import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoreConfigView, Database } from "@openplans/plugin-sdk";
import { admissionManifestSchema } from "../../../src/fetch/admission.js";
import { loadForTest } from "../../../src/plugins/testing/index.js";
import plugin, { PROVIDER_NAME, SECRETS } from "../src/index.js";
import { checkBlobStore } from "../../../src/plugins/testing/index.js";
import { startFakeS3 } from "./fake-s3.js";
import type { FakeS3 } from "./fake-s3.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
/** The operator manifest entry the README shows. */
const readmeManifest = () => {
  const block = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
    .map(
      (match) => JSON.parse(match[1]!) as { publishers?: { host: string }[] },
    )
    .find((value) => value.publishers);
  if (!block) throw new Error("README has no manifest example");
  return block as { version: 1; publishers: { host: string }[] };
};
// The kit opens no database when one is given; this plugin never queries.
const noDatabase = {} as Database;
const baseConfig: CoreConfigView = {
  db: { provider: "pg" },
  listen: { port: 3000, host: "127.0.0.1" },
  cache: { enabled: false, provider: "memory", maxMb: 0 },
  blobs: { provider: PROVIDER_NAME },
  access: { shipped: false },
  public: { quoting: true, household: true, compat: true },
  mcp: { enabled: false, allowedHosts: [], allowedOrigins: [] },
  trustProxy: [],
  cmsFallback: { enabled: false, quotes: false },
  plugins: [],
};

let fake: FakeS3;
let directory: string;
let manifestPath: string;
const secrets = () => ({
  [SECRETS.endpoint]: fake.url,
  [SECRETS.region]: fake.region,
  [SECRETS.bucket]: fake.bucket,
  [SECRETS.accessKeyId]: fake.credentials.accessKeyId,
  [SECRETS.secretAccessKey]: fake.credentials.secretAccessKey,
});
const load = (
  overrides: {
    secrets?: Record<string, string>;
    manifest?: string | null;
    options?: unknown;
  } = {},
) =>
  loadForTest(plugin, {
    db: noDatabase,
    options: overrides.options,
    secrets: overrides.secrets ?? secrets(),
    config: {
      ...baseConfig,
      access: {
        shipped: false,
        ...(overrides.manifest === null
          ? {}
          : { operatorManifest: overrides.manifest ?? manifestPath }),
      },
    },
  });

beforeEach(async () => {
  fake = await startFakeS3();
  directory = await mkdtemp(join(tmpdir(), "openplans-blob-s3-plugin-"));
  manifestPath = join(directory, "operator.json");
  const manifest = readmeManifest();
  manifest.publishers[0]!.host = "127.0.0.1";
  await writeFile(manifestPath, JSON.stringify(manifest));
});
afterEach(async () => {
  await fake.close();
  await rm(directory, { recursive: true, force: true });
});

describe("@openplans/blob-s3 plugin", () => {
  it("the README's operator manifest entry passes the core manifest schema", () => {
    expect(admissionManifestSchema.safeParse(readmeManifest()).success).toBe(
      true,
    );
  });

  it("declares its secrets and the blobs write, and registers the s3 provider", async () => {
    expect(plugin.manifest.kinds).toEqual(["blobStores"]);
    expect(plugin.manifest.capabilities?.secrets).toEqual(
      Object.values(SECRETS),
    );
    expect(plugin.manifest.capabilities?.writes).toEqual(["blobs"]);
    const loaded = await load({ options: { prefix: "openplans" } });
    try {
      const factory = loaded.registrations.blobStores.get(PROVIDER_NAME);
      expect(factory).toBeTypeOf("function");
      const results = await checkBlobStore({ create: () => factory!({}) });
      expect(results.filter((result) => !result.ok)).toEqual([]);
      expect(
        [...fake.objects.keys()].every((key) => key.startsWith("openplans/")),
      ).toBe(true);
      expect(loaded.logs).toEqual([]);
    } finally {
      await loaded.close();
    }
  });

  it("refuses incomplete settings without naming any value", async () => {
    const partial: Record<string, string> = secrets();
    delete partial[SECRETS.secretAccessKey];
    await expect(load({ secrets: partial })).rejects.toThrow(
      "S3 blob store settings are incomplete",
    );
  });

  it("refuses an endpoint host with no operator manifest entry", async () => {
    await expect(load({ manifest: null })).rejects.toMatchObject({
      code: "endpoint_not_admitted",
    });
    const other = readmeManifest();
    await writeFile(manifestPath, JSON.stringify(other));
    await expect(load()).rejects.toMatchObject({
      code: "endpoint_not_admitted",
    });
  });

  it("refuses a held host or an expired terms review", async () => {
    const held = readmeManifest() as unknown as {
      publishers: {
        host: string;
        state: string;
        terms: { expiresAt: string };
      }[];
    };
    held.publishers[0]!.host = "127.0.0.1";
    held.publishers[0]!.state = "terms-restricted";
    await writeFile(manifestPath, JSON.stringify(held));
    await expect(load()).rejects.toMatchObject({
      code: "endpoint_not_admitted",
    });
    held.publishers[0]!.state = "allowed";
    held.publishers[0]!.terms.expiresAt = "2020-01-01T00:00:00.000Z";
    await writeFile(manifestPath, JSON.stringify(held));
    await expect(load()).rejects.toMatchObject({
      code: "endpoint_not_admitted",
    });
  });

  it("refuses a malformed endpoint, and the error does not repeat it", async () => {
    const bad = {
      ...secrets(),
      [SECRETS.endpoint]: `http://user:synthetic-pass${"@"}objects.example.net`,
    };
    const error = (await load({ secrets: bad }).catch(
      (e: unknown) => e,
    )) as Error & { code: string };
    expect(error.code).toBe("invalid_endpoint");
    expect(error.message).not.toContain("synthetic-pass");
  });

  it("makes no request during setup", async () => {
    const loaded = await load();
    await loaded.close();
    expect(fake.requests).toEqual([]);
  });
});
