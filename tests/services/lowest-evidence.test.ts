import { createHash } from "node:crypto";
import type * as Crypto from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlSession } from "../../src/db/database.js";
import { relationshipInventoryCounties } from "../../src/api/repository.js";
import { expect, it, vi } from "vitest";
import type * as HandyRepository from "../../src/db/handy-repository.js";
import {
  handyVersion,
  HANDY_ALGORITHM,
} from "../../src/db/handy-repository.js";
import { canonical } from "../../src/api/cache/index.js";
import { withMutantFile, importMutant } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import { LowestEvidence } from "../../src/db/lowest-evidence.js";
import {
  decodeEvidence,
  encodeEvidence,
  evidenceNode,
  indexEvidence,
} from "../../src/db/lowest-evidence-binary.js";
import { gunzipSync, gzipSync } from "node:zlib";

vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof Crypto>();
  return { ...crypto, createHash: vi.fn(crypto.createHash) };
});

it("reuses only exact bounded source manifests and rejects a disabled-reuse mutant", async () => {
  // Synthetic source revisions isolate manifest work from pricing and SQL latency.
  const revisions = [
    "snapshot",
    "source",
    "puf_active_catalog",
    "puf_import_file",
    "plan",
    "plan_attribute",
    "rate",
    "service_area_county",
    "rating_area",
    "geo_import",
    "zcta_county",
    "state_rating_rule",
    "state_rate_active",
    "state_community_rate",
    "record_policy",
    "__database__:synthetic-manifest",
  ].map((table_name) => ({ table_name, revision: "1" }));
  const db: SqlSession = {
    query: async <Row extends Record<string, unknown>>() => ({
      rows: [{ generation: "synthetic", revisions }] as unknown as Row[],
    }),
    exec: async () => {
      throw new Error("Unexpected manifest write");
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "openplans-manifest-"));
  const config = join(directory, "config.json");
  await writeFile(config, JSON.stringify({ version: 1 }));
  vi.stubEnv("OPENPLANS_CONFIG", config);
  vi.stubEnv("OPENPLANS_GA_QUOTE_RECOVERY", "off");
  try {
    const first = await handyVersion(db);
    expect(first.manifest).toBe(
      createHash("sha256")
        .update(
          canonical([
            HANDY_ALGORITHM,
            revisions,
            { rateSourceOverrides: {} },
            false,
          ]),
        )
        .digest("hex"),
    );
    const assertReuse = async (read: typeof handyVersion) => {
      await read(db);
      vi.mocked(createHash).mockClear();
      expect(await read(db)).toEqual(first);
      expect(createHash).not.toHaveBeenCalled();
    };
    await assertReuse(handyVersion);
    const source = new URL("../../src/db/handy-repository.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "if (lastManifest?.key === key)",
        "if (false)",
      ),
      async (file) => {
        const mutant = await importMutant<typeof HandyRepository>(
          file,
          "handyVersion",
        );
        await expect(assertReuse(mutant.handyVersion)).rejects.toThrow();
      },
    );

    // Even the same generation label cannot hide different source revisions.
    revisions[0]!.revision = "2";
    expect((await handyVersion(db)).manifest).not.toBe(first.manifest);
    revisions[0]!.revision = "1";
    expect(await handyVersion(db)).toEqual(first);
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        ny: { rateSourceOverrides: { "12345": "cms-sbe" } },
      }),
    );
    expect((await handyVersion(db)).manifest).not.toBe(first.manifest);
    await writeFile(config, JSON.stringify({ version: 1 }));
    expect(await handyVersion(db)).toEqual(first);
    vi.stubEnv("OPENPLANS_GA_QUOTE_RECOVERY", "on");
    expect((await handyVersion(db)).manifest).not.toBe(first.manifest);
    vi.stubEnv("OPENPLANS_GA_QUOTE_RECOVERY", "off");
    expect(await handyVersion(db)).toEqual(first);
    await writeFile(config, JSON.stringify({ version: 2 }));
    await expect(handyVersion(db)).rejects.toThrow();
    await writeFile(config, JSON.stringify({ version: 1 }));
    const required = revisions.shift()!;
    await expect(handyVersion(db)).rejects.toThrow(
      "Data generation unavailable",
    );
    revisions.unshift(required);

    revisions.push({
      table_name: "synthetic-oversized-" + "x".repeat(65536),
      revision: "1",
    });
    await handyVersion(db);
    vi.mocked(createHash).mockClear();
    await handyVersion(db);
    expect(createHash).toHaveBeenCalledTimes(1);
    revisions.pop();
    await assertReuse(handyVersion);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("shares repeated evidence across ages and preserves exact JSON bytes", () => {
  // Synthetic proof records test storage independently of pricing.
  const evidence = new LowestEvidence();
  const proof = {
    snapshot: "synthetic",
    rows: [1, 2],
    status: "unknown",
    values: [null, false, true, -1, 1.25, 2 ** 40],
  };
  const one = { age: 0, proof, candidates: [{ id: "synthetic", proof }] };
  const two = { ...one, age: 64 };
  const root = evidence.set("one", one);
  const issuer = evidence.reference("synthetic-issuer");
  evidence.set("two", two);
  const encoded = evidence.encode();
  const loaded = new LowestEvidence(encoded.payload);
  expect(loaded.scalar(issuer)).toBe("synthetic-issuer");
  expect(loaded.scalar(null)).toBeNull();
  expect(JSON.stringify(loaded.get("one", root))).toBe(JSON.stringify(one));
  expect(JSON.stringify(loaded.get("two"))).toBe(JSON.stringify(two));
  expect(loaded.get("one", root + 1)).toBeUndefined();
  expect(loaded.get("missing")).toBeUndefined();
  expect(loaded.encode()).toEqual(encoded);
  expect(loaded.set("one", one)).toBe(root);
  expect(() => new LowestEvidence("corrupt synthetic bytes")).toThrow();
});

it("reads one subtree without decoding the rest and still validates the whole layout", () => {
  // Synthetic records; no pricing data.
  const evidence = new LowestEvidence();
  const shared = { status: "unknown", rows: [3, 4], rate: -2.5 };
  const roots = Array.from({ length: 8 }, (_, age) =>
    evidence.set(String(age), { age, shared, note: `synthetic ${age}` }),
  );
  const raw = gunzipSync(Buffer.from(evidence.encode().payload, "base64"));
  const index = indexEvidence(raw);
  const full = decodeEvidence(raw);
  expect(full.roots).toEqual(index.roots);
  expect(Array.from(index.offsets, (_, id) => evidenceNode(index, id))).toEqual(
    full.nodes,
  );
  expect(encodeEvidence(full)).toEqual(raw);
  expect(evidenceNode(index, index.offsets.length)).toBeUndefined();
  expect(evidenceNode(index, -1)).toBeUndefined();

  const loaded = new LowestEvidence(evidence.encode().payload);
  expect(loaded.get("3", roots[3])).toEqual({
    age: 3,
    shared,
    note: "synthetic 3",
  });
  expect(loaded.get("constructor")).toBeUndefined();
  // A read leaves the full dictionary undecoded; a write decodes it once.
  expect((loaded as unknown as { decoded?: unknown }).decoded).toBeUndefined();
  loaded.set("8", { age: 8, shared });
  expect((loaded as unknown as { decoded?: unknown }).decoded).toBeDefined();
  expect(loaded.get("3", roots[3])).toEqual({
    age: 3,
    shared,
    note: "synthetic 3",
  });

  const payload = (bytes: Buffer) => gzipSync(bytes).toString("base64");
  // The node table starts after the shape table; corrupt the last node's kind.
  const badKind = Buffer.from(raw);
  badKind[index.offsets[index.offsets.length - 1]!] = 9;
  expect(() => new LowestEvidence(payload(badKind))).toThrow(
    "Invalid binary county evidence",
  );
  expect(
    () => new LowestEvidence(payload(Buffer.concat([raw, Buffer.from([0])]))),
  ).toThrow("Invalid binary county evidence");
  const double = full.nodes.findIndex((node) => node[1] === -2.5);
  const infinite = Buffer.from(raw);
  infinite.writeDoubleLE(Infinity, index.offsets[double]! + 2);
  expect(() => new LowestEvidence(payload(infinite))).toThrow(
    "Invalid binary county evidence",
  );
});

it("keeps counties with no ZCTA and refuses a corrupt inventory source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-unlinked-county-"));
  try {
    // Synthetic blank-ZCTA mutation of a real Census fixture row; no pricing data.
    const [header, original] = (
      await readFile(
        new URL("../fixtures/geo/zcta-county-tx.psv", import.meta.url),
        "utf8",
      )
    ).split("\n");
    const columns = original!.split("|");
    columns[1] = "";
    const bytes = Buffer.from(header + "\n" + columns.join("|") + "\n"),
      path = join(directory, "relationship.psv");
    await writeFile(path, bytes);
    const db: SqlSession = {
      query: async <Row extends Record<string, unknown>>() => ({
        rows: [
          {
            snapshot_id: "synthetic-unlinked",
            raw_path: path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            compressed_bytes: String(bytes.length),
          },
        ] as unknown as Row[],
      }),
      exec: async () => {
        throw new Error("Unexpected inventory write");
      },
    };
    expect(await relationshipInventoryCounties(db)).toEqual([columns[9]]);
    await writeFile(
      path,
      Buffer.concat([bytes, Buffer.from("synthetic corruption")]),
    );
    await expect(relationshipInventoryCounties(db)).rejects.toThrow(
      "snapshot size mismatch",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
