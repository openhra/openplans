export type JsonStreamErrorCode =
  | "truncated"
  | "invalid_json"
  | "json_depth_exceeded"
  | "json_record_too_large"
  | "too_many_elements"
  | "array_not_found";
export class JsonStreamError extends Error {
  constructor(public readonly code: JsonStreamErrorCode) {
    super(`JSON stream: ${code}`);
    this.name = "JsonStreamError";
  }
}
export interface JsonArrayLimits {
  /** A direct property of the root object. Omit for a root array. */
  arrayKey?: string;
  /** Containers including the root envelope. */
  maxDepth?: number;
  /** Raw UTF-8 bytes per record, including whitespace, quotes and escapes. */
  maxElementBytes?: number;
  /** Raw UTF-8 bytes per string token, including its quotes and escapes. */
  maxStringBytes?: number;
  maxElements?: number;
}
/** Measured cached TX child maxima and headroom are documented in README.md. */
export const DEFAULT_JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxElementBytes: 8 * 1024 ** 2,
  maxStringBytes: 64 * 1024,
});
type Input = AsyncIterable<Uint8Array | string>;
const fail = (code: JsonStreamErrorCode): never => {
  throw new JsonStreamError(code);
};
const whitespace = (char: string) =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

class Reader {
  text = "";
  at = 0;
  private readonly iterator: AsyncIterator<Uint8Array | string>;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private ended = false;
  constructor(input: Input) {
    this.iterator = input[Symbol.asyncIterator]();
  }
  async ready(): Promise<boolean> {
    while (this.at >= this.text.length && !this.ended) {
      const next = await this.iterator.next();
      this.at = 0;
      try {
        if (next.done) {
          this.text = this.decoder.decode();
        } else if (typeof next.value === "string") {
          this.text = next.value;
        } else {
          this.text = this.decoder.decode(next.value, { stream: true });
        }
      } catch {
        fail("invalid_json");
      }
      this.ended = !!next.done;
    }
    return this.at < this.text.length;
  }
  async peek(): Promise<string> {
    return (await this.ready()) ? this.text[this.at]! : "";
  }
  async space(): Promise<void> {
    while (await this.ready()) {
      while (this.at < this.text.length && whitespace(this.text[this.at]!))
        this.at++;
      if (this.at < this.text.length) break;
    }
  }
  async expect(char: string): Promise<void> {
    const next = await this.peek();
    if (!next) fail("truncated");
    if (next !== char) fail("invalid_json");
    this.at++;
  }
  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

/** Scan just one value. Syntax is verified with JSON.parse before yielding; scanning enforces
 * depth and byte bounds before allocation. The surrounding file is never accumulated. */
async function value(
  reader: Reader,
  baseDepth: number,
  depthLimit: number,
  byteLimit: number,
  stringLimit: number,
): Promise<unknown> {
  await reader.space();
  const first = await reader.peek();
  if (!first) return fail("truncated");
  if (",]}:".includes(first)) return fail("invalid_json");
  const compound = first === "[" || first === "{",
    quoted = first === '"';
  let depth = 0,
    inString = false,
    escaped = false,
    bytes = 0,
    started = false,
    done = false;
  const fragments: string[] = [];
  let trailingHighSurrogate = false,
    stringBytes = 0;
  while (!done && (await reader.ready())) {
    const start = reader.at;
    while (reader.at < reader.text.length) {
      const char = reader.text[reader.at]!;
      if (!compound && !quoted && (whitespace(char) || ",]}:".includes(char))) {
        done = true;
        break;
      }
      reader.at++;
      const code = char.charCodeAt(0);
      // A split UTF-16 pair contributes 3 + 1 bytes, matching its four-byte UTF-8 encoding.
      let charBytes;
      if (code < 0x80) {
        charBytes = 1;
      } else if (code < 0x800) {
        charBytes = 2;
      } else if (trailingHighSurrogate && code >= 0xdc00 && code <= 0xdfff) {
        charBytes = 1;
      } else {
        charBytes = 3;
      }
      trailingHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      bytes += charBytes;
      if (bytes > byteLimit) fail("json_record_too_large");
      if (inString || char === '"') {
        stringBytes = inString ? stringBytes + charBytes : charBytes;
        if (stringBytes > stringLimit) fail("json_record_too_large");
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          inString = false;
          if (quoted) {
            done = true;
            break;
          }
        }
      } else if (char === '"') inString = true;
      else if (char === "[" || char === "{") {
        depth++;
        if (baseDepth + depth > depthLimit) fail("json_depth_exceeded");
      } else if (char === "]" || char === "}") {
        depth--;
        if (depth === 0 && compound) {
          done = true;
          break;
        }
      }
      started = true;
    }
    const fragment = reader.text.slice(start, reader.at);
    fragments.push(fragment);
  }
  if (!done && (compound || quoted || !started)) fail("truncated");
  const text = fragments.join("");
  try {
    return JSON.parse(text);
  } catch {
    if (
      !done &&
      (["true", "false", "null"].some((literal) => literal.startsWith(text)) ||
        /^-?$|^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][+-]?[0-9]*)?$/.test(
          text,
        ))
    )
      return fail("truncated");
    return fail("invalid_json");
  }
}

/** Exhaust this iterator before publishing a snapshot. On a Sanford-shaped `},` EOF it yields
 * the completed records then throws `truncated`, so a caller can quarantine the partial set. */
export async function* readJsonArray<T = unknown>(
  input: Input,
  options: JsonArrayLimits = {},
): AsyncGenerator<T> {
  const maxDepth = options.maxDepth ?? DEFAULT_JSON_LIMITS.maxDepth,
    maxBytes = options.maxElementBytes ?? DEFAULT_JSON_LIMITS.maxElementBytes;
  const maxStrings =
    options.maxStringBytes ?? DEFAULT_JSON_LIMITS.maxStringBytes;
  const maxElements = options.maxElements ?? 20_000_000;
  if (
    ![maxDepth, maxBytes, maxStrings, maxElements].every(
      (number) => Number.isSafeInteger(number) && number > 0,
    )
  ) {
    throw new RangeError("JSON limits must be positive safe integers");
  }
  const reader = new Reader(input);
  let count = 0;
  async function* array(base: number): AsyncGenerator<T> {
    if (base > maxDepth) fail("json_depth_exceeded");
    await reader.expect("[");
    await reader.space();
    if ((await reader.peek()) === "]") {
      reader.at++;
      return;
    }
    for (;;) {
      // Check EOF first so an exactly-at-limit truncated file stays classified as truncated.
      if (!(await reader.peek())) fail("truncated");
      if (++count > maxElements) fail("too_many_elements");
      yield (await value(reader, base, maxDepth, maxBytes, maxStrings)) as T;
      await reader.space();
      const delimiter = await reader.peek();
      if (delimiter === "]") {
        reader.at++;
        return;
      }
      await reader.expect(",");
      await reader.space();
      if ((await reader.peek()) === "]") fail("invalid_json");
    }
  }
  try {
    await reader.space();
    if (options.arrayKey === undefined) yield* array(1);
    else {
      await reader.expect("{");
      await reader.space();
      let found = false;
      const keys = new Set<string>();
      let keyBytes = 0;
      // Bounded key set prevents pathological metadata around the selected array.
      while ((await reader.peek()) !== "}") {
        if ((await reader.peek()) !== '"') {
          if (!(await reader.peek())) fail("truncated");
          fail("invalid_json");
        }
        const key = await value(reader, 1, maxDepth, maxBytes, maxStrings);
        if (typeof key !== "string" || keys.has(key)) fail("invalid_json");
        if (keys.size >= maxElements) fail("too_many_elements");
        keyBytes += Buffer.byteLength(key as string);
        if (keyBytes > maxBytes) fail("json_record_too_large");
        keys.add(key as string);
        await reader.space();
        await reader.expect(":");
        await reader.space();
        if (key === options.arrayKey) {
          found = true;
          yield* array(2);
        } else await value(reader, 1, maxDepth, maxBytes, maxStrings);
        await reader.space();
        if ((await reader.peek()) === "}") break;
        await reader.expect(",");
        await reader.space();
        if ((await reader.peek()) === "}") fail("invalid_json");
      }
      await reader.expect("}");
      if (!found) fail("array_not_found");
    }
    await reader.space();
    if (await reader.peek()) fail("invalid_json");
  } finally {
    await reader.close();
  }
}

/** Bounded small-document companion for index/metadata JSON, sharing the same depth scanner. */
export async function readJsonValue(
  input: Input,
  options: Pick<
    JsonArrayLimits,
    "maxDepth" | "maxElementBytes" | "maxStringBytes"
  > = {},
): Promise<unknown> {
  const depth = options.maxDepth ?? DEFAULT_JSON_LIMITS.maxDepth,
    bytes = options.maxElementBytes ?? DEFAULT_JSON_LIMITS.maxElementBytes;
  const strings = options.maxStringBytes ?? DEFAULT_JSON_LIMITS.maxStringBytes;
  if (
    ![depth, bytes, strings].every(
      (number) => Number.isSafeInteger(number) && number > 0,
    )
  )
    throw new RangeError("Invalid JSON limits");
  const reader = new Reader(input);
  try {
    const result = await value(reader, 0, depth, bytes, strings);
    await reader.space();
    if (await reader.peek()) fail("invalid_json");
    return result;
  } finally {
    await reader.close();
  }
}
