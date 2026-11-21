import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// The carrier-document extractors are Python (stdlib + Poppler pdftotext) source preparation
// tools, tested by test_carrier_documents.py on synthetic documents only. Tests that need
// pdftotext skip in Python with a reason when Poppler is not installed.
const here = fileURLToPath(new URL(".", import.meta.url));
const tool = process.env.OPENPLANS_PDFTOTEXT || "pdftotext";
const poppler = spawnSync(tool, ["-v"], { encoding: "utf8" }).error
  ? undefined
  : tool;

const run = () =>
  spawnSync(
    "python3",
    ["-B", "-m", "unittest", "discover", "-s", here, "-p", "test_*.py", "-v"],
    {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );

it("formulary and SBC extractors pass their synthetic-document tests", () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/\nOK\b/);
});

// A job that declares Poppler available (OPENPLANS_REQUIRE_POPPLER=1) must not skip the case below.
it.runIf(
  process.env.OPENPLANS_REQUIRE_POPPLER &&
    process.env.OPENPLANS_REQUIRE_POPPLER !== "0",
)("Poppler is installed where it is declared required", () => {
  expect(
    poppler,
    "pdftotext not found; the PDF tests would skip",
  ).toBeDefined();
});

it.skipIf(!poppler)(
  "with Poppler installed nothing is skipped and every planted mutant is killed (skipped: pdftotext not on PATH)",
  () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/skipped/);
    const killed = result.stderr.match(/mutant killed: /g) ?? [];
    expect(killed.length, result.stderr).toBe(12);
  },
);
