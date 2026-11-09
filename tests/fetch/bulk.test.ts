import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bulkSpecSchema,
  runBulk,
  verifyBulkPayload,
  verifyBulkReport,
} from "../../src/fetch/bulk.js";
const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "bulk-control-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
function spec(dir: string) {
  return {
    id: "synthetic-control",
    dataDir: dir,
    admissionManifest: join(dir, "admission.json"),
    reportPath: join(dir, "report.json"),
    allowHosts: ["publisher.invalid"],
    targets: [
      {
        url: "https://publisher.invalid/feed.json",
        source: "synthetic",
        expectedContent: "json" as const,
        jsonArray: true,
      },
    ],
    maxTransferBytes: 10000,
    maxFileBytes: 5000,
    maxRequests: 20,
    wallSeconds: 100,
  };
}
describe("bounded bulk collection", () => {
  it("refuses caps beyond the owner budget and unknown fields", async () => {
    const dir = await directory();
    expect(bulkSpecSchema.safeParse(spec(dir)).success).toBe(true);
    expect(
      bulkSpecSchema.safeParse({
        ...spec(dir),
        maxTransferBytes: 20 * 1024 ** 3 + 1,
      }).success,
    ).toBe(false);
    expect(
      bulkSpecSchema.safeParse({ ...spec(dir), wallSeconds: 86401 }).success,
    ).toBe(false);
    expect(
      bulkSpecSchema.safeParse({ ...spec(dir), transport: "bypass" }).success,
    ).toBe(false);
  });
  it("stops without network when publisher admission is missing", async () => {
    const dir = await directory();
    await writeFile(
      join(dir, "admission.json"),
      '{"version":1,"publishers":[]}',
    );
    const report = await runBulk(spec(dir));
    expect(report.state).toBe("stopped");
    expect(report.error?.code).toBe("admission_denied");
    expect(report.items).toEqual([]);
    await expect(verifyBulkReport(spec(dir))).rejects.toThrow("incomplete");
  });
  it("requires valid JSON EOF and detects hash and byte mutations", async () => {
    const dir = await directory();
    const path = join(dir, "payload");
    const target = spec(dir).targets[0]!;
    const body = '[{"synthetic":true}]';
    await writeFile(path, body);
    const hash = createHash("sha256").update(body).digest("hex");
    expect(
      await verifyBulkPayload(path, hash, Buffer.byteLength(body), target),
    ).toEqual({ records: 1 });
    await expect(
      verifyBulkPayload(path, "0".repeat(64), body.length, target),
    ).rejects.toThrow("differs");
    await expect(
      verifyBulkPayload(path, hash, body.length + 1, target),
    ).rejects.toThrow("differs");
    const partial = body.slice(0, -1) + ",";
    await writeFile(path, partial);
    const partialHash = createHash("sha256").update(partial).digest("hex");
    await expect(
      verifyBulkPayload(path, partialHash, partial.length, target),
    ).rejects.toThrow("truncated");
  });
  it("verifies CSV EOF and rejects an unterminated quoted field", async () => {
    const dir = await directory();
    const path = join(dir, "payload");
    const target = {
      ...spec(dir).targets[0]!,
      expectedContent: "csv" as const,
    };
    for (const [body, valid] of [
      ["a,b\n1,2\n", true],
      ['a,b\n1,"cut', false],
    ] as const) {
      await writeFile(path, body);
      const hash = createHash("sha256").update(body).digest("hex");
      const check = verifyBulkPayload(path, hash, body.length, target);
      if (valid)
        expect(await check).toEqual({ records: 1, csvColumnMismatches: 0 });
      else await expect(check).rejects.toThrow();
    }
    expect((await readFile(path, "utf8")).endsWith("cut")).toBe(true);
  });
});

it("quarantines malformed source bytes, continues, and detects report or payload mutation", async () => {
  const cache = await import("../../src/fetch/cache.js");
  const { vi } = await import("vitest");
  const dir = await directory();
  const input = spec(dir);
  const manifest = '{"synthetic":true}';
  await writeFile(input.admissionManifest, manifest);
  const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
  input.targets.push({
    ...input.targets[0]!,
    url: "https://publisher.invalid/second.json",
  });
  const admission = {
    manifestSha256,
    hosts: [
      {
        host: "publisher.invalid",
        state: "allowed" as const,
        termsSha256: "a".repeat(64),
        robots: {
          url: "https://publisher.invalid/robots.txt",
          status: 200,
          sha256: "b".repeat(64),
          checkedAt: new Date().toISOString(),
        },
      },
    ],
  };
  const snapshots = await Promise.all(
    ['[{"synthetic":true},', '[{"synthetic":true}]'].map(
      async (body, index) => {
        const path = join(dir, `payload-${index}`);
        const metadataPath = join(dir, `meta-${index}.json`);
        await writeFile(path, body);
        const sha256 = createHash("sha256").update(body).digest("hex");
        const metadata = {
          snapshot_id: sha256,
          source: "synthetic",
          url: input.targets[index]!.url,
          final_url: input.targets[index]!.url,
          redirect_chain: [],
          status: 200,
          content_type: "application/json",
          etag: null,
          last_modified: null,
          sha256,
          bytes: body.length,
          fetched_at: new Date().toISOString(),
          access_policy: admission,
        };
        await writeFile(metadataPath, JSON.stringify(metadata));
        return {
          outcome: "downloaded" as const,
          snapshotId: sha256,
          path,
          metadataPath,
          metadata,
          admission,
        };
      },
    ),
  );
  const fetch = vi.spyOn(cache, "fetchToCache");
  fetch
    .mockResolvedValueOnce(snapshots[0]!)
    .mockResolvedValueOnce(snapshots[1]!);
  try {
    const report = await runBulk(input);
    expect(report.state).toBe("completed");
    expect(report.items.map((item) => item.state)).toEqual([
      "quarantined",
      "verified",
    ]);
    expect(report.items[0]!.validationError?.code).toBe("truncated");
    expect(fetch).toHaveBeenCalledTimes(2);
    await verifyBulkReport(input);
    await verifyBulkReport(input, false);
    const missing = { ...report, items: report.items.slice(0, 1) };
    await writeFile(input.reportPath, JSON.stringify(missing));
    await expect(verifyBulkReport(input)).rejects.toThrow("incomplete");
    await writeFile(input.reportPath, JSON.stringify(report));
    await writeFile(snapshots[1]!.path, '[{"synthetic":null}]');
    await expect(verifyBulkReport(input)).rejects.toThrow("differs");
  } finally {
    fetch.mockRestore();
  }
});

it("records CSV column drift without changing the published bytes", async () => {
  const dir = await directory();
  const path = join(dir, "payload");
  const body = "a,b\n1,2,\n";
  await writeFile(path, body);
  const sha = createHash("sha256").update(body).digest("hex");
  expect(
    await verifyBulkPayload(path, sha, body.length, {
      ...spec(dir).targets[0]!,
      expectedContent: "csv",
    }),
  ).toEqual({ records: 1, csvColumnMismatches: 1 });
  expect(await readFile(path, "utf8")).toBe(body);
});

it("streams ZIP CRCs and rejects damaged members even when the outer SHA matches", async () => {
  const { syntheticZip } = await import("../fixtures/fetch/generate.mjs");
  const dir = await directory();
  const path = join(dir, "synthetic.zip");
  const body = "synthetic source bytes";
  const name = "synthetic.txt";
  const bytes = syntheticZip([{ name, body }], { stored: true });
  const target = { ...spec(dir).targets[0]!, expectedContent: "zip" as const };
  await writeFile(path, bytes);
  const hash = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");
  expect(
    await verifyBulkPayload(path, hash(bytes), bytes.length, target),
  ).toEqual({ zipMembers: 1, zipUncompressedBytes: body.length });
  bytes[30 + Buffer.byteLength(name)]! ^= 1;
  await writeFile(path, bytes);
  await expect(
    verifyBulkPayload(path, hash(bytes), bytes.length, target),
  ).rejects.toMatchObject({ code: "invalid_zip" });
});

it("rejects URLs that could place credentials or query tokens in durable job specs", async () => {
  const dir = await directory();
  const credentialUrl = new URL("https://publisher.invalid/a");
  credentialUrl.username = "synthetic-user";
  credentialUrl.password = "synthetic-password";
  for (const url of [
    "http://publisher.invalid/a",
    credentialUrl.href,
    "https://publisher.invalid/a?synthetic-token=one",
    "https://publisher.invalid/a#fragment",
  ]) {
    const input = spec(dir);
    input.targets[0]!.url = url;
    expect(bulkSpecSchema.safeParse(input).success).toBe(false);
  }
});
