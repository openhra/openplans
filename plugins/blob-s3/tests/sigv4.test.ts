import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import {
  amzDate,
  canonicalRequest,
  sha256Hex,
  sign,
  stringToSign,
} from "../src/sigv4.js";
import type * as SigV4Module from "../src/sigv4.js";

interface Case {
  name: string;
  method: string;
  path: string;
  query: [string, string][];
  headers: Record<string, string>;
  body: string;
  canonicalRequest?: string;
  stringToSign?: string;
  authorization: string;
}
const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/sigv4-vectors.json", import.meta.url),
    "utf8",
  ),
) as {
  status: string;
  comment: string;
  suite: {
    credentials: { accessKeyId: string; secretAccessKey: string };
    region: string;
    service: string;
    cases: Case[];
  };
  s3GetObject: {
    secretAccessKey: string;
    region: string;
    service: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    signature: string;
  };
};
const sigv4File = new URL("../src/sigv4.ts", import.meta.url);

function signCase(module: typeof SigV4Module, entry: Case) {
  return module.sign(
    {
      method: entry.method,
      path: entry.path,
      query: entry.query,
      headers: entry.headers,
      payloadHash: module.sha256Hex(entry.body),
    },
    vectors.suite.credentials,
    vectors.suite.region,
    vectors.suite.service,
  ).authorization;
}

// The vectors are an unverified copy of the published suite; the fixture's comment names the
// source. A value that disagrees with the source is a fixture error until the copy is pinned.
describe("Signature Version 4 test vectors (unverified copy)", () => {
  it("the fixture says it is an unverified copy and names its public source", () => {
    expect(vectors.status).toBe("unverified copy");
    expect(vectors.comment).toMatch(/aws-sig-v4-test-suite/);
    expect(vectors.comment).toMatch(/S3 API Reference/);
  });

  it.each(vectors.suite.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_name, entry) => {
      const request = {
        method: entry.method,
        path: entry.path,
        query: entry.query,
        headers: entry.headers,
        payloadHash: sha256Hex(entry.body),
      };
      if (entry.canonicalRequest)
        expect(canonicalRequest(request)).toBe(entry.canonicalRequest);
      if (entry.stringToSign)
        expect(
          stringToSign(
            entry.headers["X-Amz-Date"]!,
            "20150830/us-east-1/service/aws4_request",
            canonicalRequest(request),
          ),
        ).toBe(entry.stringToSign);
      expect(signCase(await import("../src/sigv4.js"), entry)).toBe(
        entry.authorization,
      );
    },
  );

  it("signs the S3 GET object example", () => {
    const example = vectors.s3GetObject;
    // The signature does not depend on the access key ID, so a placeholder stands in.
    const { signature } = sign(
      {
        method: example.method,
        path: example.path,
        headers: example.headers,
        payloadHash: example.headers["x-amz-content-sha256"]!,
      },
      { accessKeyId: "PLACEHOLDER", secretAccessKey: example.secretAccessKey },
      example.region,
      example.service,
    );
    expect(signature).toBe(example.signature);
  });

  it("formats request dates", () => {
    expect(amzDate(new Date("2015-08-30T12:36:00.123Z"))).toBe(
      "20150830T123600Z",
    );
  });

  it("negative control: header values signed without trimming fail the vectors", async () => {
    const mutant = await plantMutant(
      sigv4File,
      'value.trim().replace(/ +/g, " ")',
      "value",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof SigV4Module;
      const failing = vectors.suite.cases.filter(
        (entry) => signCase(module, entry) !== entry.authorization,
      );
      expect(failing.map((entry) => entry.name)).toEqual([
        "get-header-value-trim",
      ]);
    } finally {
      await mutant.cleanup();
    }
  });

  it("negative control: an unsorted query fails the vectors", async () => {
    const mutant = await plantMutant(sigv4File, ".sort(byNameThenValue)", "");
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof SigV4Module;
      const failing = vectors.suite.cases.filter(
        (entry) => signCase(module, entry) !== entry.authorization,
      );
      expect(failing.map((entry) => entry.name)).toEqual([
        "get-vanilla-query-order-key-case",
      ]);
    } finally {
      await mutant.cleanup();
    }
  });
});
