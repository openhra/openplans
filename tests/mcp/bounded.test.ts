import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  assertOutputCount,
  assertOutputFits,
  boundOutput,
  DEFAULT_OUTPUT_BYTES,
  fitsOutput,
  measuredToolResult,
  serializedBytes,
} from "../../src/mcp/bounded.js";
import type * as Bounded from "../../src/mcp/bounded.js";
import { importMutant, plantMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import { boundLowestResult } from "../../src/mcp/handy.js";

it("measures both representations exactly while serializing each payload only once", () => {
  for (const text of ['é\\"\n', "😀", "\ud800", "", "x".repeat(31_000)]) {
    const serialize = vi.fn(() => ({ text }));
    const value = { evidence: { toJSON: serialize } };
    const measured = measuredToolResult(value, 4096);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(measured.bytes).toBe(serializedBytes(measured.answer, 4096));
    expect(measured.answer.content[0]!.text).toBe(JSON.stringify(value));
  }
});

it("lowest bounding reuses the one serialized payload for a fitting answer", () => {
  const serialize = vi.fn(() => ({ synthetic: 'é\\"\n' }));
  const result = {
    ties: ["synthetic-plan"],
    provenance: {
      candidates: [],
      excluded: [],
      evidence: [{ toJSON: serialize }],
    },
    truncated: false,
    omitted: { ties: 0, candidates: 0, excluded: 0, evidence: 0 },
  };
  const text = boundLowestResult(result);
  expect(serialize).toHaveBeenCalledTimes(1);
  expect(text).toBe(JSON.stringify(result));
});

it("negative control: reserializing structured content violates the work bound", async () => {
  const source = new URL("../../src/mcp/bounded.ts", import.meta.url);
  const mutant = await plantMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "serializedBytes({ ...answer, structuredContent: null }, reserve)",
      "serializedBytes(answer, reserve) - Buffer.byteLength(text) + 4",
    ),
  );
  try {
    const changed = await importMutant<typeof Bounded>(
      mutant.url,
      "measuredToolResult",
    );
    const check = (measure: typeof measuredToolResult) => {
      const serialize = vi.fn(() => ({ synthetic: "evidence" }));
      measure({ evidence: { toJSON: serialize } });
      expect(serialize).toHaveBeenCalledTimes(1);
    };
    check(measuredToolResult);
    expect(() => check(changed.measuredToolResult)).toThrow();
  } finally {
    await mutant.cleanup();
  }
});

it("measures UTF-8 JSON bytes, escaping and the framing reserve at the inclusive boundary", () => {
  const value = { text: 'é\\"\n' };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  expect(serializedBytes(value, 512)).toBe(bytes + 512);
  expect(fitsOutput(value, { maxBytes: bytes })).toBe(true);
  expect(fitsOutput(value, { maxBytes: bytes - 1 })).toBe(false);
  expect(() => assertOutputFits("x".repeat(DEFAULT_OUTPUT_BYTES))).toThrow(
    "RESULT_TOO_LARGE",
  );
  expect(() => assertOutputCount(100, 100)).not.toThrow();
  expect(() => assertOutputCount(101, 100)).toThrow("RESULT_TOO_LARGE");
});

it("pages complete rows in order, counts omissions and measures the updated cursor", () => {
  // Synthetic detail rows. The cursor is the index of the next unread row.
  const original = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  const output = {
    rows: [...original],
    truncated: false,
    next_cursor: null as number | null,
  };
  const result = boundOutput(output, {
    maxBytes: 160,
    groups: [{ rows: output.rows, minimum: 1 }],
    complete: (omitted) => {
      output.truncated = omitted > 0;
      output.next_cursor = omitted ? 10 + output.rows.length : null;
    },
  });
  expect(output.rows).toEqual(original.slice(0, 2));
  expect(result.omitted).toBe(1);
  expect(output.next_cursor).toBe(12);
  expect(output.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(160);
});

it("omits groups in declared order and rechecks evidence counts even when bytes fit", () => {
  const output = { detail: [1, 2], sources: [1, 2], omitted: [0, 0] };
  const result = boundOutput(output, {
    groups: [output.detail, output.sources].map((rows, i) => ({
      rows,
      onOmit: () => {
        output.omitted[i]!++;
      },
    })),
    withinLimits: () => output.detail.length + output.sources.length <= 1,
  });
  expect(result.omitted).toBe(3);
  expect(output).toEqual({ detail: [], sources: [1], omitted: [2, 1] });
});

it("leaves fitting answers byte-identical and refuses irreducible calculations and singletons", () => {
  const output = { rows: ["first", "second"], truncated: false };
  const before = JSON.stringify(output);
  expect(boundOutput(output, { groups: [{ rows: output.rows }] }).omitted).toBe(
    0,
  );
  expect(JSON.stringify(output)).toBe(before);
  const calculation = { evidence: ["x".repeat(DEFAULT_OUTPUT_BYTES)] };
  expect(() => boundOutput(calculation, { groups: [] })).toThrow(
    "RESULT_TOO_LARGE",
  );
  expect(() =>
    boundOutput(calculation, {
      groups: [{ rows: calculation.evidence, minimum: 1 }],
    }),
  ).toThrow("RESULT_TOO_LARGE");
  expect(calculation.evidence).toHaveLength(1);
});

it("negative control: a disabled byte check admits a planted oversize answer", async () => {
  const source = new URL("../../src/mcp/bounded.ts", import.meta.url);
  const mutant = await plantMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "return measure(value) <= maxBytes;",
      "return true;",
    ),
  );
  try {
    const changed = await importMutant<typeof Bounded>(
      mutant.url,
      "assertOutputFits",
    );
    const oversize = { synthetic: "x".repeat(DEFAULT_OUTPUT_BYTES) };
    const check = (assertFits: typeof assertOutputFits) =>
      expect(() => assertFits(oversize)).toThrow("RESULT_TOO_LARGE");
    check(assertOutputFits);
    expect(() => check(changed.assertOutputFits)).toThrow();
  } finally {
    await mutant.cleanup();
  }
});
