import { createHash } from "node:crypto";
import { expect } from "vitest";
import { applicationVersion } from "../../../src/mcp/version.js";

export interface ResponseDigest {
  status: number;
  body_sha256: string;
  headers: Record<string, string | null>;
}
export const stableHeaders = [
  "content-type",
  "cache-control",
  "x-cache",
  "x-openplans-gaps",
  "x-quote-tier",
] as const;

type BodyHeader = { version: unknown };

// Locate a JSON value without reserializing its neighbours or changing whitespace.
function versionSpans(
  json: string,
  initialization: boolean,
): [number, number][] {
  const tokens = [
    ...json.matchAll(/"(?:\\.|[^"\\])*"|[^\s{}[\],:]+|[{}[\],:]/g),
  ];
  let index = 0;
  const spans: [number, number][] = [];
  function value(path: string[]): void {
    const token = tokens[index++]!;
    if (token[0] === "{") {
      while (tokens[index]![0] !== "}") {
        const key = JSON.parse(tokens[index++]![0]) as string;
        index++; // colon
        value([...path, key]);
        if (tokens[index]![0] !== ",") break;
        index++;
      }
      index++; // closing brace
    } else if (token[0] === "[") {
      let item = 0;
      while (tokens[index]![0] !== "]") {
        value([...path, String(item++)]);
        if (tokens[index]![0] !== ",") break;
        index++;
      }
      index++; // closing bracket
    } else if (
      (initialization &&
        path.length === 3 &&
        path[0] === "result" &&
        path[1] === "serverInfo" &&
        path[2] === "version") ||
      (path.length === 4 &&
        path[0] === "result" &&
        path[1] === "_meta" &&
        path[2] === "io.modelcontextprotocol/serverInfo" &&
        path[3] === "version")
    ) {
      spans.push([token.index, token.index + token[0].length]);
    }
  }
  value([]);
  return spans;
}

function canonicalJson(json: string, headers: BodyHeader[]): string {
  const message = JSON.parse(json) as {
    jsonrpc?: unknown;
    result?: {
      protocolVersion?: unknown;
      serverInfo?: { version?: unknown };
      _meta?: { "io.modelcontextprotocol/serverInfo"?: { version?: unknown } };
    };
  } | null;
  if (message?.jsonrpc !== "2.0" || !message.result) return json;
  const result = message.result;
  const previousHeaders = headers.length;
  const initialization = Boolean(
    result.serverInfo && "protocolVersion" in result,
  );
  if (initialization) headers.push({ version: result.serverInfo!.version });
  const metadata = result._meta?.["io.modelcontextprotocol/serverInfo"];
  if (metadata) headers.push({ version: metadata.version });
  if (headers.length === previousHeaders) return json;
  for (const [start, end] of versionSpans(json, initialization).reverse())
    json = json.slice(0, start) + '"<application-version>"' + json.slice(end);
  return json;
}

export function canonicalBody(
  bytes: Buffer,
  contentType: string | null,
): { body: Buffer; header: BodyHeader[] } {
  const header: BodyHeader[] = [];
  // Only MCP server identity metadata is release-dependent. Data/schema versions,
  // build fields and timestamps stay in the byte contract.
  if (
    !bytes.includes('"serverInfo"') &&
    !bytes.includes('"io.modelcontextprotocol/serverInfo"')
  )
    return { body: bytes, header };
  const text = bytes.toString("utf8");
  let body = text;
  if (contentType?.startsWith("application/json"))
    body = canonicalJson(text, header);
  else if (contentType?.startsWith("text/event-stream"))
    body = text.replace(
      /^(data: ?)([^\r\n]*)/gm,
      (_line, prefix: string, json: string) =>
        prefix + canonicalJson(json, header),
    );
  return { body: header.length ? Buffer.from(body) : bytes, header };
}

/** Assert release metadata separately; hash every remaining response byte. */
export async function responseDigest(
  response: Response,
  expectedVersion = applicationVersion,
): Promise<ResponseDigest> {
  const { body, header } = canonicalBody(
    Buffer.from(await response.arrayBuffer()),
    response.headers.get("content-type"),
  );
  for (const metadata of header)
    expect(metadata, "MCP server identity body header").toEqual({
      version: expectedVersion,
    });
  return {
    status: response.status,
    body_sha256: createHash("sha256").update(body).digest("hex"),
    headers: Object.fromEntries(
      stableHeaders.map((name) => [name, response.headers.get(name)]),
    ),
  };
}
