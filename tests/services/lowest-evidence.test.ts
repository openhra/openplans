import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlSession } from "../../src/db/database.js";
import { relationshipInventoryCounties } from "../../src/api/repository.js";
import { expect, it } from "vitest";
import { LowestEvidence } from "../../src/db/lowest-evidence.js";
import {
  decodeEvidence,
  encodeEvidence,
  evidenceNode,
  indexEvidence,
} from "../../src/db/lowest-evidence-binary.js";
import { gunzipSync, gzipSync } from "node:zlib";

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
