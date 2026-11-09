import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  JsonStreamError,
  readJsonArray,
  readJsonValue,
} from "../../../src/ingest/json/index.js";
import type { JsonArrayLimits } from "../../../src/ingest/json/index.js";

async function* chunks(text: string, size = 1): AsyncGenerator<Buffer> {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; at += size)
    yield bytes.subarray(at, at + size);
}
async function collect(input: AsyncIterable<unknown>): Promise<unknown[]> {
  const result = [];
  for await (const item of input) result.push(item);
  return result;
}
const parse = (text: string, options: JsonArrayLimits = {}, size = 1) =>
  collect(readJsonArray(chunks(text, size), options));

describe("bounded streaming JSON arrays", () => {
  it("handles nested values, escaped delimiters, UTF-8 split across chunks, scalars and empty arrays", async () => {
    const values = [
      { text: '😀},[\\"', nested: [1, { ok: null }] },
      false,
      null,
      -1.25e2,
      "é",
      [],
    ];
    for (const size of [1, 2, 7, 4096])
      expect(await parse(JSON.stringify(values), {}, size)).toEqual(values);
    expect(await parse(" \n[]\t")).toEqual([]);
  });
  it("preserves Unicode pairs across text-stream chunks and counts their UTF-8 bytes", async () => {
    async function* text() {
      for (const char of '["😀"]'.split("")) yield char;
    }
    expect(
      await collect(readJsonArray(text(), { maxElementBytes: 6 })),
    ).toEqual(["😀"]);
    await expect(
      collect(readJsonArray(text(), { maxElementBytes: 5 })),
    ).rejects.toMatchObject({ code: "json_record_too_large" });
  });
  it("selects a named root property and validates the rest of the object", async () => {
    expect(
      await parse('{"before":{},"drugs":[1,2],"after":[true]}', {
        arrayKey: "drugs",
      }),
    ).toEqual([1, 2]);
    await expect(
      parse('{"other":[]}', { arrayKey: "drugs" }),
    ).rejects.toMatchObject({ code: "array_not_found" });
    await expect(
      parse('{"drugs":[],"drugs":[]}', { arrayKey: "drugs" }),
    ).rejects.toMatchObject({ code: "invalid_json" });
    await expect(
      parse('{"drugs":[1]} garbage', { arrayKey: "drugs" }),
    ).rejects.toMatchObject({ code: "invalid_json" });
  });
  it("negative control: D1 tail yields two good elements then truncated; a swallowing mutant is caught", async () => {
    const path = new URL(
      "../../fixtures/json/sanford-tail.synthetic.json",
      import.meta.url,
    );
    expect(await readFile(path, "utf8")).toBe(
      '[\n{"synthetic":true,"id":"one"},\n{"synthetic":true,"id":"two"},\n',
    );
    async function verify(reader: AsyncIterable<unknown>): Promise<void> {
      const rows: unknown[] = [];
      let code: string | undefined;
      try {
        for await (const row of reader) rows.push(row);
      } catch (error) {
        if (error instanceof JsonStreamError) code = error.code;
        else throw error;
      }
      if (rows.length !== 2 || code !== "truncated")
        throw new Error("truncation guard failed");
    }
    await verify(readJsonArray(createReadStream(path, { highWaterMark: 1 })));
    async function* swallowingMutant(): AsyncGenerator<unknown> {
      try {
        yield* readJsonArray(createReadStream(path));
      } catch {
        /* deliberately broken */
      }
    }
    await expect(verify(swallowingMutant())).rejects.toThrow(
      "truncation guard failed",
    );
  });
  it.each([
    "[",
    "[{}",
    "[{},",
    '["unfinished',
    "[tru",
    "[1e",
    "[1.",
    "[-",
    '{"drugs":[1,',
    '{"drugs":[1]',
  ])("rejects EOF inside %s", async (text) => {
    await expect(
      parse(text, text.startsWith("{") ? { arrayKey: "drugs" } : {}),
    ).rejects.toMatchObject({ code: "truncated" });
  });
  it("negative controls: depth, byte size (including multibyte) and total element limits", async () => {
    expect(await parse("[[{}]]", { maxDepth: 3 })).toEqual([[{}]]);
    await expect(parse("[[{}]]", { maxDepth: 2 })).rejects.toMatchObject({
      code: "json_depth_exceeded",
    });
    expect(await parse('["é"]', { maxElementBytes: 4 })).toEqual(["é"]);
    await expect(parse('["é"]', { maxElementBytes: 3 })).rejects.toMatchObject({
      code: "json_record_too_large",
    });
    await expect(
      parse(`["${"x".repeat(5000)}"]`, { maxElementBytes: 32 }, 8192),
    ).rejects.toMatchObject({ code: "json_record_too_large" });
    expect(await parse("[1,2]", { maxElements: 2 })).toEqual([1, 2]);
    await expect(parse("[1,2,3]", { maxElements: 2 })).rejects.toMatchObject({
      code: "too_many_elements",
    });
  });
  it.each([
    "[1,]",
    "[,1]",
    "[true false]",
    "[{]}]",
    "[01]",
    "[1]tail",
    '["\\q"]',
    "[NaN]",
  ])("rejects malformed JSON %s", async (text) => {
    await expect(parse(text)).rejects.toBeInstanceOf(JsonStreamError);
  });
  it("yields before pulling the tail and closes the source on early cancellation", async () => {
    let tailPulled = false,
      closed = false;
    async function* input() {
      try {
        yield Buffer.from('[{"first":1},');
        tailPulled = true;
        yield Buffer.from("2]");
      } finally {
        closed = true;
      }
    }
    for await (const value of readJsonArray(input())) {
      expect(value).toEqual({ first: 1 });
      break;
    }
    expect(tailPulled).toBe(false);
    expect(closed).toBe(true);
  });
  it("rejects invalid UTF-8 and bounds small index documents with the same scanner", async () => {
    async function* invalid() {
      yield Buffer.from([91, 34, 0xff, 34, 93]);
    }
    await expect(collect(readJsonArray(invalid()))).rejects.toMatchObject({
      code: "invalid_json",
    });
    expect(await readJsonValue(chunks('{"a":[1]}'))).toEqual({ a: [1] });
    await expect(
      readJsonValue(chunks('{"a":[1]}'), { maxDepth: 1 }),
    ).rejects.toMatchObject({ code: "json_depth_exceeded" });
  });
  it("negative control: 10,000 nested containers fail by name without recursion or pulling the tail", async () => {
    for (const mode of ["array", "value", "envelope"]) {
      let closed = false,
        tailPulled = false;
      async function* input() {
        try {
          yield Buffer.from(
            (mode === "envelope" ? '{"rows":' : "") + "[".repeat(10_000),
          );
          tailPulled = true;
          yield Buffer.from(
            "0" + "]".repeat(10_000) + (mode === "envelope" ? "}" : ""),
          );
        } finally {
          closed = true;
        }
      }
      const result =
        mode === "value"
          ? readJsonValue(input())
          : collect(
              readJsonArray(
                input(),
                mode === "envelope" ? { arrayKey: "rows" } : {},
              ),
            );
      await expect(result).rejects.toMatchObject({
        name: "JsonStreamError",
        code: "json_depth_exceeded",
      });
      expect(tailPulled).toBe(false);
      expect(closed).toBe(true);
    }
  });
  it("bounds strings independently of records, including keys, escapes, multibyte and text chunk pairs", async () => {
    for (const size of [1, 2, 4096]) {
      expect(
        await parse('[{"key":"é😀"}]', { maxStringBytes: 8 }, size),
      ).toEqual([{ key: "é😀" }]);
      await expect(
        parse('[{"key":"é😀"}]', { maxStringBytes: 7 }, size),
      ).rejects.toMatchObject({ code: "json_record_too_large" });
      await expect(
        parse('[{"toolong":0}]', { maxStringBytes: 8 }, size),
      ).rejects.toMatchObject({ code: "json_record_too_large" });
      await expect(
        parse('["\\u0041"]', { maxStringBytes: 7 }, size),
      ).rejects.toMatchObject({ code: "json_record_too_large" });
    }
    async function* text() {
      for (const char of '["😀"]'.split("")) yield char;
    }
    expect(await collect(readJsonArray(text(), { maxStringBytes: 6 }))).toEqual(
      ["😀"],
    );
    await expect(
      collect(readJsonArray(text(), { maxStringBytes: 5 })),
    ).rejects.toMatchObject({ code: "json_record_too_large" });
    await expect(
      readJsonValue(chunks('{"x":"long"}'), { maxStringBytes: 5 }),
    ).rejects.toMatchObject({ code: "json_record_too_large" });
    await expect(
      parse('{"metadata":"long","rows":[]}', {
        arrayKey: "rows",
        maxStringBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "json_record_too_large" });
  });
  it("rejects an oversized record of individually short strings before pulling more input", async () => {
    let closed = false,
      tailPulled = false;
    async function* input() {
      try {
        yield Buffer.from('[{"synthetic":["a","b","c","d"');
        tailPulled = true;
        yield Buffer.from("]}]");
      } finally {
        closed = true;
      }
    }
    await expect(
      collect(readJsonArray(input(), { maxElementBytes: 24 })),
    ).rejects.toMatchObject({ code: "json_record_too_large" });
    expect(closed).toBe(true);
    expect(tailPulled).toBe(false);
  });
  it("enforces envelope depth even for empty arrays", async () => {
    await expect(
      parse('{"rows":[]}', { arrayKey: "rows", maxDepth: 1 }),
    ).rejects.toMatchObject({ code: "json_depth_exceeded" });
    expect(
      await parse('{"rows":[]}', { arrayKey: "rows", maxDepth: 2 }),
    ).toEqual([]);
  });
  it("rejects invalid limit configuration before reading", async () => {
    for (const key of [
      "maxDepth",
      "maxElementBytes",
      "maxStringBytes",
    ] as const)
      for (const limit of [0, -1, Infinity, 1.5]) {
        await expect(parse("[]", { [key]: limit })).rejects.toBeInstanceOf(
          RangeError,
        );
        await expect(
          readJsonValue(chunks("{}"), { [key]: limit }),
        ).rejects.toBeInstanceOf(RangeError);
      }
  });
});
