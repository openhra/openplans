import { StringDecoder } from "node:string_decoder";

export type CsvErrorCode =
  | "invalid_quote"
  | "unterminated_quote"
  | "record_too_long"
  | "invalid_header"
  | "column_count";
export class CsvError extends Error {
  constructor(
    readonly code: CsvErrorCode,
    readonly rowNumber: number,
    message: string,
  ) {
    super(`CSV row ${rowNumber}: ${message}`);
    this.name = "CsvError";
  }
}
export interface CsvOptions {
  delimiter?: string;
  /** Maximum encoded UTF-8 bytes in one logical record, excluding its terminating newline. */
  maxRecordLength?: number;
  /** Map published headers to field names; unspecified headers retain their names. */
  headerMap?:
    | Readonly<Record<string, string>>
    | ((header: string, index: number) => string);
}
export interface CsvRecord {
  /** Physical starting line (1-based), including the header. */
  rowNumber: number;
  /** Logical record number (1-based), including the header. */
  recordNumber: number;
  fields: string[];
}
export interface CsvRow extends CsvRecord {
  values: Record<string, string>;
}

/** Backpressure follows the consumer. Only the current record and input chunk are retained. */
export async function* readRecords(
  input: AsyncIterable<Uint8Array | string>,
  options: CsvOptions = {},
): AsyncGenerator<CsvRecord> {
  const delimiter = options.delimiter ?? ",";
  const maximum = options.maxRecordLength ?? 1024 * 1024;
  if (
    delimiter.length !== 1 ||
    /[\r\n"\uFEFF]/.test(delimiter) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1
  )
    throw new TypeError("Invalid CSV options");
  const decoder = new StringDecoder("utf8");
  let field = "",
    fields: string[] = [];
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let line = 1,
    startLine = 1,
    recordNumber = 1,
    length = 0;
  let first = true,
    skipLf = false,
    previousCr = false;
  function finish(): CsvRecord {
    const record = {
      rowNumber: startLine,
      recordNumber: recordNumber++,
      fields: [...fields, field],
    };
    field = "";
    fields = [];
    state = "start";
    length = 0;
    return record;
  }
  function* consume(text: string): Generator<CsvRecord> {
    for (const char of text) {
      if (first) {
        first = false;
        if (char === "\uFEFF") continue;
      }
      if (skipLf) {
        skipLf = false;
        if (char === "\n") {
          previousCr = false;
          startLine = line;
          continue;
        }
      }
      const newline = char === "\r" || char === "\n";
      if (newline && state !== "quoted") {
        const record = finish();
        if (char === "\r" || !previousCr) line++;
        previousCr = char === "\r";
        skipLf = char === "\r";
        startLine = line;
        yield record;
        continue;
      }
      length += Buffer.byteLength(char, "utf8");
      if (length > maximum)
        throw new CsvError(
          "record_too_long",
          startLine,
          "record exceeds byte limit",
        );
      if (state === "quoted") {
        if (char === '"') state = "closed";
        else field += char;
      } else if (state === "closed") {
        if (char === '"') {
          field += '"';
          state = "quoted";
        } else if (char === delimiter) {
          fields.push(field);
          field = "";
          state = "start";
        } else
          throw new CsvError(
            "invalid_quote",
            startLine,
            "unexpected character after closing quote",
          );
      } else if (char === delimiter) {
        fields.push(field);
        field = "";
        state = "start";
      } else if (char === '"') {
        if (state !== "start")
          throw new CsvError(
            "invalid_quote",
            startLine,
            "quote inside unquoted field",
          );
        state = "quoted";
      } else {
        field += char;
        state = "plain";
      }
      if (char === "\r" || (char === "\n" && !previousCr)) line++;
      previousCr = char === "\r";
    }
  }
  for await (const chunk of input) {
    yield* consume(
      typeof chunk === "string"
        ? decoder.end() + chunk
        : decoder.write(Buffer.from(chunk)),
    );
  }
  yield* consume(decoder.end());
  if ((state as string) === "quoted")
    throw new CsvError(
      "unterminated_quote",
      startLine,
      "unterminated quoted field",
    );
  if (length || fields.length || state !== "start") yield finish();
}

export async function* readCsv(
  input: AsyncIterable<Uint8Array | string>,
  options: CsvOptions = {},
): AsyncGenerator<CsvRow> {
  let headers: string[] | undefined;
  for await (const record of readRecords(input, options)) {
    if (!headers) {
      headers = record.fields.map((name, index) => {
        const header = name.trim();
        return typeof options.headerMap === "function"
          ? options.headerMap(header, index)
          : options.headerMap && Object.hasOwn(options.headerMap, header)
            ? options.headerMap[header]!
            : header;
      });
      if (
        headers.some((name) => !name) ||
        new Set(headers).size !== headers.length
      ) {
        throw new CsvError(
          "invalid_header",
          record.rowNumber,
          "blank or duplicate mapped header",
        );
      }
    } else {
      if (record.fields.length !== headers.length)
        throw new CsvError(
          "column_count",
          record.rowNumber,
          "field count differs from header",
        );
      yield {
        ...record,
        values: Object.fromEntries(
          headers.map((header, index) => [header, record.fields[index]!]),
        ),
      };
    }
  }
  if (!headers) throw new CsvError("invalid_header", 1, "missing header");
}
