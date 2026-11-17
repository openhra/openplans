import { expect, it } from "vitest";
import { applicationVersion } from "../../src/mcp/version.js";
import { canonicalBody, responseDigest } from "./admin-support/digests.js";

type SyntheticEnvelope = {
  result: {
    protocolVersion?: string;
    serverInfo?: { version?: unknown };
    _meta: { "io.modelcontextprotocol/serverInfo": { version?: unknown } };
    data?: {
      version: string;
      build: string;
      timestamp: string;
      serverInfo?: { version: string };
      samples?: unknown[];
    };
    structuredContent?: { version: string; timestamp: string };
  };
};

// Synthetic protocol envelopes contain no plan data.
function initialization(version = applicationVersion) {
  return JSON.stringify({
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "openplans", version },
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: "openplans", version },
      },
    },
    jsonrpc: "2.0",
    id: 1,
  });
}

function response(json: string, transport: "json" | "sse") {
  return new Response(
    transport === "sse" ? `event: message\r\ndata: ${json}\r\n\r\n` : json,
    {
      headers: {
        "content-type":
          transport === "sse" ? "text/event-stream" : "application/json",
        "cache-control": "no-store",
      },
    },
  );
}

for (const transport of ["json", "sse"] as const) {
  it(`${transport}: a version bump keeps the digest and asserts the new header`, async () => {
    const original = await responseDigest(
      response(initialization(), transport),
    );
    const bumped = initialization("999.0.0-synthetic");
    expect(
      await responseDigest(response(bumped, transport), "999.0.0-synthetic"),
    ).toEqual(original);
    await expect(responseDigest(response(bumped, transport))).rejects.toThrow(
      "MCP server identity body header",
    );
    const bytes = Buffer.from(bumped);
    const canonical = canonicalBody(bytes, "application/json");
    expect(canonical.header).toEqual([
      { version: "999.0.0-synthetic" },
      { version: "999.0.0-synthetic" },
    ]);
    expect(canonical.body.toString()).toBe(
      bumped.replaceAll('"999.0.0-synthetic"', '"<application-version>"'),
    );
  });

  it(`${transport}: the planted response field mutant fails digest identity`, async () => {
    const original = await responseDigest(
      response(initialization(), transport),
    );
    const mutant = await responseDigest(
      response(initialization().replace('"openplans"', '"mutant"'), transport),
    );
    expect(() => expect(mutant).toEqual(original)).toThrow();
  });

  it(`${transport}: whitespace remains part of the byte contract`, async () => {
    const original = await responseDigest(
      response(initialization(), transport),
    );
    const mutant = await responseDigest(
      response(initialization() + " ", transport),
    );
    expect(() => expect(mutant).toEqual(original)).toThrow();
  });

  it(`${transport}: missing or malformed version metadata is rejected separately`, async () => {
    for (const version of [undefined, null, 12]) {
      const json = JSON.parse(initialization()) as SyntheticEnvelope;
      json.result.serverInfo!.version = version;
      await expect(
        responseDigest(response(JSON.stringify(json), transport)),
      ).rejects.toThrow("MCP server identity body header");
    }
  });
}

it("keeps data versions, build fields, timestamps, framing and other bytes intact", () => {
  const json = JSON.parse(initialization()) as SyntheticEnvelope;
  json.result.data = {
    version: "synthetic-data-version",
    build: "synthetic-build",
    timestamp: "2026-01-01T00:00:00Z",
    serverInfo: { version: applicationVersion },
    samples: [
      null,
      true,
      { version: applicationVersion, note: 'synthetic "quoted" value' },
    ],
  };
  const pretty = JSON.stringify(json, null, 2);
  const stream = `: heartbeat\nevent: message\ndata: ${initialization()}\n\ndata: ${JSON.stringify(json)}\n\n`;
  for (const [text, type] of [
    [pretty, "application/json"],
    [stream, "text/event-stream"],
  ] as const) {
    const canonical = canonicalBody(Buffer.from(text), type);
    const expected =
      type === "application/json"
        ? text.replace(
            /("name": "openplans",\n\s*"version": )"[^"]*"/g,
            '$1"<application-version>"',
          )
        : text.replaceAll(
            `"name":"openplans","version":"${applicationVersion}"`,
            '"name":"openplans","version":"<application-version>"',
          );
    expect(canonical.header).toHaveLength(type === "application/json" ? 2 : 4);
    expect(canonical.body.toString()).toBe(expected);
  }
});

it("does not normalize a version outside the server identity metadata paths", async () => {
  for (const body of [
    { version: applicationVersion, build: "synthetic", timestamp: "synthetic" },
    { result: { serverInfo: { version: applicationVersion } } },
    {
      result: {
        protocolVersion: "1",
        data: { serverInfo: { version: applicationVersion } },
      },
    },
  ]) {
    const bytes = Buffer.from(JSON.stringify(body));
    expect(canonicalBody(bytes, "application/json")).toEqual({
      body: bytes,
      header: [],
    });
    const changed = Buffer.from(
      bytes.toString().replace(applicationVersion, "synthetic-mutant"),
    );
    const original = await responseDigest(response(bytes.toString(), "json"));
    expect(
      await responseDigest(response(changed.toString(), "json")),
    ).not.toEqual(original);
  }
});

it("rejects changed protocol versions, data versions, builds and timestamps", async () => {
  const json = JSON.parse(initialization()) as SyntheticEnvelope;
  json.result.data = {
    version: "1",
    build: "synthetic",
    timestamp: "2026-01-01T00:00:00Z",
  };
  const original = await responseDigest(response(JSON.stringify(json), "json"));
  for (const field of ["version", "build", "timestamp"] as const) {
    const mutant = structuredClone(json);
    mutant.result.data![field] += "-mutant";
    expect(
      await responseDigest(response(JSON.stringify(mutant), "json")),
    ).not.toEqual(original);
  }
  json.result.protocolVersion = "synthetic-mutant";
  expect(
    await responseDigest(response(JSON.stringify(json), "json")),
  ).not.toEqual(original);
});

for (const transport of ["json", "sse"] as const) {
  it(`${transport}: normalizes tool result server metadata and rejects a stale header`, async () => {
    const message = JSON.parse(initialization()) as SyntheticEnvelope;
    delete message.result.serverInfo;
    delete message.result.protocolVersion;
    message.result.structuredContent = {
      version: "synthetic-data-version",
      timestamp: "synthetic-time",
    };
    const original = await responseDigest(
      response(JSON.stringify(message), transport),
    );
    message.result._meta["io.modelcontextprotocol/serverInfo"].version =
      "999.0.0-synthetic";
    const bumped = JSON.stringify(message);
    expect(
      await responseDigest(response(bumped, transport), "999.0.0-synthetic"),
    ).toEqual(original);
    await expect(responseDigest(response(bumped, transport))).rejects.toThrow(
      "MCP server identity body header",
    );
    delete message.result._meta["io.modelcontextprotocol/serverInfo"].version;
    await expect(
      responseDigest(response(JSON.stringify(message), transport)),
    ).rejects.toThrow("MCP server identity body header");
  });
}

it("keeps non-metadata serverInfo fields intact after a metadata-bearing SSE event", () => {
  const data = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: { serverInfo: { version: applicationVersion } },
  });
  const stream = `data: ${initialization()}\n\ndata: ${data}\n\n`;
  const canonical = canonicalBody(Buffer.from(stream), "text/event-stream");
  expect(canonical.header).toHaveLength(2);
  expect(canonical.body.toString()).toBe(
    `data: ${initialization().replaceAll(`"version":"${applicationVersion}"`, '"version":"<application-version>"')}\n\ndata: ${data}\n\n`,
  );
});
