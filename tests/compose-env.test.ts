import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * .env.example keys that no compose service reads, with why. A key not here must be forwarded
 * by compose.yml (`${KEY...}`), or the test fails.
 */
const HOST_ONLY: Record<string, string> = {
  // Compose interpolation and host port mappings.
  POSTGRES_USER: "interpolation",
  POSTGRES_PASSWORD: "interpolation",
  POSTGRES_DB: "interpolation",
  API_PORT: "host port",
  DB_PORT: "host port",
  OPENPLANS_DB_MEMORY: "interpolation",
  OPENPLANS_CACHE_MEMORY: "interpolation",
  OPENPLANS_DB_IMAGE: "interpolation",
  OPENPLANS_DATA_DIR: "host mount source; the worker sees /data",
  // Native entry points; compose builds these inside the container.
  DATABASE_URL: "native only",
  PORT: "native only",
  HOST: "native only",
  // Documented as needing a local Compose override (docs/configuration.md).
  OPENPLANS_COMPAT_CATASTROPHIC_AGE_RULE: "override",
  OPENPLANS_COMPAT_BENEFIT_TEXT: "override",
  OPENPLANS_MEDICARE_PART_D: "override",
  OPENPLANS_MEDICARE_DRUG_COST: "override",
  OPENPLANS_MEDICARE_DRUG_COST_PRICES: "override",
  OPENPLANS_GA_QUOTE_RECOVERY: "override",
  OPENPLANS_SHIPPED_ACCESS: "override",
  OPENPLANS_PROJECT_URL: "override",
  OPENPLANS_EGRESS_FILE: "override",
  OPENPLANS_EGRESS_SHA256: "override",
  OPENPLANS_SITE_APPROVALS_FILE: "forwarded",
  // Regional geocoder script, run on the host.
  OPENPLANS_GEOCODER_STATE: "host script",
  OPENPLANS_GEOCODER_SNAPSHOT: "host script",
  OPENPLANS_GEOCODER_PORT: "host script",
  // Developer, check and smoke runners.
  OPENPLANS_PGLITE_DIR: "runner",
  OPENPLANS_PUF_DB: "runner",
  OPENPLANS_FORMULARY_DB: "runner",
  OPENPLANS_PROVIDER_DB: "runner",
  OPENPLANS_FORMULARY_REPORT: "runner",
  OPENPLANS_QHP_DB: "runner",
  OPENPLANS_QHP_DATABASE_URL: "runner",
  OPENPLANS_QHP_CATALOG_DB: "runner",
  OPENPLANS_QHP_MIGRATIONS_DIRECTORY: "runner",
  OPENPLANS_QHP_STATE: "runner",
  OPENPLANS_QHP_YEAR: "runner",
  OPENPLANS_QHP_ISSUER: "runner",
  OPENPLANS_QHP_ENRICHMENT: "runner",
  OPENPLANS_QHP_RESUME: "runner",
  OPENPLANS_QHP_RUN_BUDGET_MS: "runner",
  OPENPLANS_QHP_REPORT_PREFIX: "runner",
  OPENPLANS_REFERENCE_CAPTURES_DIR: "runner",
  OPENPLANS_DENYLIST_FILE: "publication check",
  OPENPLANS_COMPOSE_PROJECT: "smoke",
  OPENPLANS_SMOKE_TMPDIR: "smoke",
};

/** Keys written as `KEY=` or `# KEY=` at the start of a line. */
function exampleKeys(text: string): string[] {
  return [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
}

/** Names compose.yml reads: `${KEY...}` and service environment keys. */
function composeNames(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\$\{([A-Z][A-Z0-9_]+)[:}-]/g)].map((m) => m[1]!),
  );
}

function unaccounted(example: string, compose: string): string[] {
  const read = composeNames(compose);
  return exampleKeys(example).filter(
    (key) => !read.has(key) && !(key in HOST_ONLY),
  );
}

describe(".env.example keys", () => {
  it("are forwarded by compose.yml or listed as host-only", async () => {
    const example = await readFile(
      new URL("../.env.example", import.meta.url),
      "utf8",
    );
    const compose = await readFile(
      new URL("../compose.yml", import.meta.url),
      "utf8",
    );
    expect(unaccounted(example, compose)).toEqual([]);
    for (const key of [
      "CMS_API_KEY",
      "OPENPLANS_GEOCODER_URL",
      "OPENPLANS_GEOCODER_KEY",
      "OPENPLANS_OPEN_GEOCODER_URL",
      "OPENPLANS_RAW_READ_ONLY",
      "OPENPLANS_IMAGE",
    ])
      expect(exampleKeys(example)).toContain(key);
  });

  it("worker and scheduler forward the CMS key and the geocoder settings", async () => {
    const compose = await readFile(
      new URL("../compose.yml", import.meta.url),
      "utf8",
    );
    for (const name of ["worker", "scheduler"]) {
      const body = compose
        .split(`\n  ${name}:\n`)[1]!
        .split(/\n {2}[a-z]+:\n|\nconfigs:\n/)[0]!;
      for (const key of [
        "CMS_API_KEY",
        "OPENPLANS_GEOCODER_URL",
        "OPENPLANS_OPEN_GEOCODER_URL",
      ])
        expect(body, `${name} ${key}`).toContain(`${key}: \${${key}:-}`);
    }
  });

  it("negative control: a planted key no service reads is reported", async () => {
    const example = await readFile(
      new URL("../.env.example", import.meta.url),
      "utf8",
    );
    const compose = await readFile(
      new URL("../compose.yml", import.meta.url),
      "utf8",
    );
    expect(
      unaccounted(`${example}\n# OPENPLANS_PLANTED_UNREAD=1\n`, compose),
    ).toEqual(["OPENPLANS_PLANTED_UNREAD"]);
  });
});
