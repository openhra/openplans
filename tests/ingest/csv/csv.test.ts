import { describe, expect, it } from "vitest";
import {
  CsvError,
  readCsv,
  readRecords,
} from "../../../src/ingest/csv/index.js";

async function* chunks(text: string, size = 1) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += size)
    yield bytes.subarray(i, i + size);
}
async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const row of rows) result.push(row);
  return result;
}
describe("streaming delimited reader", () => {
  it("handles split UTF-8 BOM, CRLF, escaped quotes, embedded CRLF, delimiters, empty and final fields", async () => {
    const rows = await collect(
      readCsv(
        chunks(
          '\uFEFFid|label|last\r\n00601|"café|""quoted""\r\nnext"|\r\n48001|plain|end',
        ),
        {
          delimiter: "|",
          headerMap: { id: "fips" },
        },
      ),
    );
    expect(rows).toEqual([
      {
        rowNumber: 2,
        recordNumber: 2,
        fields: ["00601", 'café|"quoted"\r\nnext', ""],
        values: { fips: "00601", label: 'café|"quoted"\r\nnext', last: "" },
      },
      {
        rowNumber: 4,
        recordNumber: 3,
        fields: ["48001", "plain", "end"],
        values: { fips: "48001", label: "plain", last: "end" },
      },
    ]);
  });
  it("maps headers with a function, supports CR, and preserves trailing empty fields", async () => {
    expect(
      (
        await collect(
          readCsv(chunks("a,b\r1,\r2,3\r"), {
            headerMap: (header) => header.toUpperCase(),
          }),
        )
      ).map((r) => r.values),
    ).toEqual([
      { A: "1", B: "" },
      { A: "2", B: "3" },
    ]);
    expect(await collect(readRecords(chunks('"",')))).toEqual([
      { rowNumber: 1, recordNumber: 1, fields: ["", ""] },
    ]);
  });
  it.each([
    ['id,name\n1,"broken', {}, "unterminated_quote", 2],
    ['id,name\n1,"multi\nline', {}, "unterminated_quote", 2],
    ["id,name\n1,abcdefgh", { maxRecordLength: 7 }, "record_too_long", 2],
    ['id\n"ééé"', { maxRecordLength: 7 }, "record_too_long", 2],
    ['id,name\n1,bad"quote', {}, "invalid_quote", 2],
    ['id,name\n1,"ok"junk', {}, "invalid_quote", 2],
    ["id,name\n1", {}, "column_count", 2],
    ["id,id\n1,2", {}, "invalid_header", 1],
    ["", {}, "invalid_header", 1],
  ] as const)(
    "negative control: rejects malformed record %# with typed row error",
    async (text, options, code, rowNumber) => {
      const result = collect(readCsv(chunks(text), options));
      await expect(result).rejects.toBeInstanceOf(CsvError);
      await expect(result).rejects.toMatchObject({ code, rowNumber });
    },
  );
  it("does not map inherited object properties as headers", async () => {
    const rows = await collect(
      readCsv(chunks("constructor,toString\n1,2"), { headerMap: {} }),
    );
    expect(rows[0]!.values).toEqual({ constructor: "1", toString: "2" });
  });
  it("stops pulling the source when the consumer stops", async () => {
    let pulls = 0,
      closed = false;
    async function* source() {
      try {
        for (const text of ["h\n", "first\n", "never\n"]) {
          pulls++;
          yield text;
        }
      } finally {
        closed = true;
      }
    }
    for await (const row of readCsv(source())) {
      expect(row.values.h).toBe("first");
      break;
    }
    expect(pulls).toBe(2);
    expect(closed).toBe(true);
  });
});
