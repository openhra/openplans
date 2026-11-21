// The operator manifest fixture for carrier plan-document hosts (formulary and SBC PDFs). It is
// deployment config, not a shipped manifest: an operator points OPENPLANS_ACCESS_MANIFEST at a copy.
// These tests run the real AdmissionSession against the robots files those hosts served
// (tests/fixtures/robots) through an in-memory policy reader; nothing touches the network.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AdmissionSession,
  admissionManifestSchema,
} from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
} from "../../src/fetch/index.js";
import type { PolicyDocument } from "../../src/fetch/admission.js";
import { parseRobots } from "../../src/fetch/robots.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/access/carrier-documents.json", import.meta.url),
);
const robotsDir = fileURLToPath(
  new URL("../fixtures/robots/", import.meta.url),
);
const robotsFiles: Record<string, string> = {
  "www.christushealthplan.org": "christushealthplan.txt",
  "senderohealth.com": "senderohealth.txt",
  "capitalhealth.com": "capitalhealth.txt",
  "alliantplans.com": "alliantplans.txt",
};
/** The document directories found on each host; discovery pages are permitted only as exact paths. */
const documentDirectories: Record<string, string[]> = {
  "www.christushealthplan.org": [],
  "chppayment.christushealth.org": [
    "/documents/HIX/formulary/",
    "/documents/2026/HIX/TX_SBC/",
    "/documents/2026/HIX/LA_SBC/",
  ],
  "senderohealth.com": ["/files/2025/"],
  "capitalhealth.com": ["/chp-document/", "/wp-content/uploads/"],
};
const insideUrls: Record<string, string> = {
  "www.christushealthplan.org":
    "https://www.christushealthplan.org/member-resources/individual-families/forms-documents",
  "chppayment.christushealth.org":
    "https://chppayment.christushealth.org/documents/2026/HIX/LA_SBC/example_2026.pdf",
  "senderohealth.com":
    "https://senderohealth.com/files/2025/71837TX001000100.pdf",
  "capitalhealth.com":
    "https://capitalhealth.com/wp-content/uploads/2025/08/example-formulary.pdf",
};
const outsideUrls: Record<string, string> = {
  "www.christushealthplan.org":
    "https://www.christushealthplan.org/find-a-doctor",
  "chppayment.christushealth.org":
    "https://chppayment.christushealth.org/payments/index.html",
  "senderohealth.com": "https://senderohealth.com/files/json/index.json",
  "capitalhealth.com": "https://capitalhealth.com/members/login/",
};
const alliantPdf = "https://alliantplans.com/wp-content/uploads/formulary.pdf";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let robotsText: Record<string, string>;
let baseline: AdmissionManifest;
let directory: string;

beforeAll(async () => {
  robotsText = {};
  for (const [host, file] of Object.entries(robotsFiles))
    robotsText[host] = await readFile(join(robotsDir, file), "utf8");
  baseline = JSON.parse(
    await readFile(fixturePath, "utf8"),
  ) as AdmissionManifest;
  directory = await mkdtemp(join(tmpdir(), "openplans-carrier-manifest-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  // Inside the terms reviews' window, so the fixture does not expire under the test.
  vi.useFakeTimers({
    now: Date.parse("2026-11-21T12:00:00Z"),
    toFake: ["Date"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Serves each host's recorded robots answer and the pinned terms documents. */
function reader(manifest: AdmissionManifest) {
  return async (url: URL): Promise<PolicyDocument> => {
    if (url.pathname === "/robots.txt") {
      const text = robotsText[url.hostname];
      if (text === undefined)
        return { status: 404, sha256: null, text: "", absent: true };
      return {
        status: 200,
        sha256: sha(text),
        text,
        contentType: "text/plain",
      };
    }
    const terms = manifest.publishers.find(
      (entry) => entry.terms?.url === url.href,
    )?.terms;
    if (!terms) return { status: 404, sha256: null, text: "" };
    return {
      status: 200,
      sha256: terms.sha256,
      text: "",
      contentType: "text/html",
    };
  };
}

let written = 0;
async function session(manifest: AdmissionManifest) {
  const path = join(directory, `manifest-${++written}.json`);
  await writeFile(path, JSON.stringify(manifest));
  return new AdmissionSession(path, undefined, { egressCountry: "CO" });
}
async function authorize(manifest: AdmissionManifest, href: string) {
  return (await session(manifest)).authorize(new URL(href), reader(manifest));
}
const entry = (manifest: AdmissionManifest, host: string): PublisherPolicy =>
  manifest.publishers.find((publisher) => publisher.host === host)!;

// Each control throws when the property it guards is broken; mutants below must trip them.
const controls: Record<string, (manifest: AdmissionManifest) => Promise<void>> =
  {
    "permitted paths stay within the document directories and exact discovery pages":
      async (m) => {
        for (const [host, directories] of Object.entries(documentDirectories)) {
          const publisher = entry(m, host);
          const discovery = publisher.discoveryUrls
            .map((href) => new URL(href))
            .filter((url) => url.hostname === host)
            .map((url) => url.pathname);
          for (const path of publisher.permittedPaths)
            if (path === "/" || ![...directories, ...discovery].includes(path))
              throw new Error(`${host} permits ${path}`);
        }
      },
    "a path outside permittedPaths is refused": async (m) => {
      for (const [host, href] of Object.entries(outsideUrls)) {
        const refused = await authorize(m, href).then(
          () => undefined,
          (error: Error) => error.message,
        );
        if (
          refused !== "Path is outside the publisher's reviewed permitted paths"
        )
          throw new Error(`${host}: ${refused ?? "admitted"}`);
      }
    },
    "alliantplans.com is held by the manifest": async (m) => {
      const refused = await authorize(m, alliantPdf).then(
        () => undefined,
        (error: Error) => error.message,
      );
      if (
        refused !==
        "Publisher host is held by its reviewed manifest (robots-disallowed)"
      )
        throw new Error(refused ?? "admitted");
    },
  };

/** Planted mutants: each must trip the named control. */
const mutants: Record<
  string,
  { control: string; mutate: (m: AdmissionManifest) => void }
> = {
  "a permittedPath widened to /": {
    control: "a path outside permittedPaths is refused",
    mutate: (m) => {
      entry(m, "chppayment.christushealth.org").permittedPaths = ["/"];
    },
  },
  "a permittedPath widened to / (structural)": {
    control:
      "permitted paths stay within the document directories and exact discovery pages",
    mutate: (m) => {
      entry(m, "capitalhealth.com").permittedPaths.push("/");
    },
  },
  "the robots-disallowed host admitted": {
    control: "alliantplans.com is held by the manifest",
    mutate: (m) => {
      const alliant = entry(m, "alliantplans.com");
      alliant.state = "allowed";
      alliant.permittedPaths = ["/"];
      alliant.terms = {
        ...entry(m, "capitalhealth.com").terms!,
        url: "https://alliantplans.com/terms/",
      };
    },
  },
};

describe("carrier plan-document operator manifest", () => {
  it("validates against the admission manifest schema", () => {
    expect(admissionManifestSchema.safeParse(baseline).error).toBeUndefined();
    expect(baseline.publishers.map((publisher) => publisher.host)).toEqual([
      "www.christushealthplan.org",
      "chppayment.christushealth.org",
      "senderohealth.com",
      "capitalhealth.com",
      "alliantplans.com",
    ]);
  });

  it("pins the robots files these tests replay", () => {
    for (const [host, text] of Object.entries(robotsText))
      expect(entry(baseline, host).robots?.sha256, host).toBe(sha(text));
  });

  it("records the direct robots 404 on chppayment with the observing country", () => {
    expect(
      entry(baseline, "chppayment.christushealth.org").robots,
    ).toMatchObject({
      status: 404,
      sha256: null,
      country: "CO",
    });
  });

  it("admits a document path on every allowed host", async () => {
    for (const href of Object.values(insideUrls))
      await expect(
        authorize(baseline, href),
        href,
      ).resolves.toBeGreaterThanOrEqual(5000);
  });

  for (const [name, control] of Object.entries(controls))
    it(`control holds on the fixture: ${name}`, async () => {
      await expect(control(structuredClone(baseline))).resolves.toBeUndefined();
    });

  it("refuses alliantplans.com PDFs at robots too, even if the hold were lifted", async () => {
    expect(
      parseRobots(robotsText["alliantplans.com"]!).allows(new URL(alliantPdf)),
    ).toBe(false);
    const lifted = structuredClone(baseline);
    mutants["the robots-disallowed host admitted"]!.mutate(lifted);
    await expect(authorize(lifted, alliantPdf)).rejects.toThrow(
      "Publisher robots policy is stale or disallows this path",
    );
  });

  it("paces capitalhealth.com at its 10 s crawl delay", async () => {
    expect(parseRobots(robotsText["capitalhealth.com"]!).delayMs).toBe(10_000);
    expect(entry(baseline, "capitalhealth.com").delayMs).toBe(10_000);
    await expect(
      authorize(baseline, insideUrls["capitalhealth.com"]!),
    ).resolves.toBe(10_000);
    // The live robots file still sets the pace if the manifest's own delay is lowered.
    const lowered = structuredClone(baseline);
    entry(lowered, "capitalhealth.com").delayMs = 5000;
    await expect(
      authorize(lowered, insideUrls["capitalhealth.com"]!),
    ).resolves.toBe(10_000);
    await expect(
      authorize(baseline, insideUrls["senderohealth.com"]!),
    ).resolves.toBe(5000);
  });

  for (const [name, { control, mutate }] of Object.entries(mutants))
    it(`mutant is caught: ${name}`, async () => {
      const mutated = structuredClone(baseline);
      mutate(mutated);
      expect(admissionManifestSchema.safeParse(mutated).success).toBe(true);
      await expect(controls[control]!(mutated)).rejects.toThrow();
    });
});
