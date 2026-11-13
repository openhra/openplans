import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zip } from "../ingest/medicare/helpers.ts";

// Every command the builder runs is a fake here: docker and node only record their arguments,
// and the subset script runs on a SYNTHETIC mini-archive whose contract IDs, NDCs and prices are
// invented. Only the member names and column headers follow the CMS Part D SPUF layout.
const BUILDER = "scripts/oracle/build-price-check-db.sh";
const SUBSET = "scripts/oracle/price-check-subset.py";
let directory;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-price-check-db-"));
});
afterAll(() => rm(directory, { recursive: true, force: true }));

/** A copy of the builder in its own tree, with fake docker and node on PATH. */
async function tree(name) {
  const root = join(directory, name);
  await mkdir(join(root, "scripts/oracle"), { recursive: true });
  await mkdir(join(root, "dist/ingest/medicare"), { recursive: true });
  await writeFile(join(root, "dist/ingest/medicare/spuf.js"), "");
  await copyFile(BUILDER, join(root, BUILDER));
  const bin = join(root, "bin");
  await mkdir(bin);
  const log = join(root, "calls.log");
  const state = join(root, "container");
  // The fake docker remembers whether the container exists.
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> '${log}'
[ "$1" = --context ] && shift 2
case "$1" in
  ps) [ -f '${state}' ] && echo c0ffee; exit 0 ;;
  image) exit 0 ;;
  run) : > '${state}'; echo c0ffee ;;
  start) [ -f '${state}' ] ;;
  exec) exit 0 ;;
  port) echo 127.0.0.1:55432 ;;
  rm) rm -f '${state}' ;;
esac
`,
  );
  await writeFile(
    join(bin, "node"),
    `#!/usr/bin/env bash\nprintf 'node DATABASE_URL=%s %s\\n' "$DATABASE_URL" "$*" >> '${log}'\n`,
  );
  await chmod(join(bin, "docker"), 0o755);
  await chmod(join(bin, "node"), 0o755);
  const run = (args, env = {}) =>
    spawnSync("bash", [join(root, BUILDER), ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        OPENPLANS_DATA_DIR: join(root, "data"),
        ...env,
      },
    });
  const calls = async () =>
    existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n") : [];
  return { root, run, calls, log };
}

describe("build-price-check-db.sh arguments", () => {
  it("rejects bad actions, years, flags and a build or remove with no target", async () => {
    const { run, calls } = await tree("arguments");
    for (const args of [
      [],
      ["load"],
      ["build"],
      ["remove"],
      ["build", "--year", "2027", "--database-url", "postgres://x/y"],
      ["build", "--year"],
      ["build", "--database-url"],
      ["build", "--database-url", ""],
      ["build", "--work", "/tmp/w"],
      ["build", "--database-url", "postgres://x/y", "--tables", "pricing"],
      ["remove", "--database-url", "postgres://x/y"],
    ]) {
      const result = run(args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("Usage:");
      expect(result.stdout).toBe("");
    }
    expect(await calls()).toEqual([]);
  });

  it("loads a named database and prints only its URL on stdout", async () => {
    const { root, run, calls } = await tree("url");
    const result = run(["build", "--database-url", "postgres://h/db"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("postgres://h/db\n");
    expect(await calls()).toEqual([
      `node DATABASE_URL=postgres://h/db --max-old-space-size=4096 scripts/oracle/price-check-load.mjs --year 2026 --work ${join(root, "data/price-check/2026")}`,
    ]);
    // The environment names the database too; a flag wins over it.
    const env = run(["build", "--work", join(root, "w")], {
      OPENPLANS_PRICE_CHECK_DATABASE_URL: "postgres://env/db",
    });
    expect(env.stdout).toBe("postgres://env/db\n");
    const flag = run(["build", "--database-url", "postgres://flag/db"], {
      OPENPLANS_PRICE_CHECK_DOCKER_CONTEXT: "lanes",
    });
    expect(flag.stdout).toBe("postgres://flag/db\n");
    expect((await calls()).some((line) => line.startsWith("docker"))).toBe(
      false,
    );
  });

  it("refuses to load before dist is built", async () => {
    const { root, run, calls } = await tree("nodist");
    await rm(join(root, "dist"), { recursive: true });
    const result = run(["build", "--database-url", "postgres://h/db"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm run build");
    expect(await calls()).toEqual([]);
  });
});

describe("build-price-check-db.sh container", () => {
  it("starts the container once, reuses it on a second build and removes it", async () => {
    const { run, calls, log } = await tree("docker");
    const first = run(["build", "--docker-context", "lanes"]);
    expect(first.status, first.stderr).toBe(0);
    const url = "postgres://openplans@127.0.0.1:55432/price_check\n";
    expect(first.stdout).toBe(url);
    const once = await calls();
    expect(
      once.filter((l) => l.startsWith("docker --context lanes run")),
    ).toHaveLength(1);
    expect(once.find((l) => l.includes(" run "))).toContain(
      "--name openplans-price-check-2026-db",
    );
    expect(once.find((l) => l.includes(" run "))).toContain(
      "-p 127.0.0.1::5432",
    );
    expect(
      once.every(
        (l) => !l.startsWith("docker") || l.includes("--context lanes"),
      ),
    ).toBe(true);
    await rm(log);
    const second = run(["build"], {
      OPENPLANS_PRICE_CHECK_DOCKER_CONTEXT: "lanes",
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(url);
    const again = await calls();
    expect(again.some((l) => l.includes(" run "))).toBe(false);
    expect(again).toContain(
      "docker --context lanes start openplans-price-check-2026-db",
    );
    expect(again.at(-1)).toContain(`DATABASE_URL=${url.trim()}`);
    await rm(log);
    expect(run(["remove", "--docker-context", "lanes"]).status).toBe(0);
    expect(await calls()).toEqual([
      "docker --context lanes rm -f openplans-price-check-2026-db",
      "docker --context lanes volume rm openplans-price-check-2026-data",
    ]);
  });
});

describe("realdata.sh --with-price-check", () => {
  it("builds the database and runs the check without --optional", async () => {
    const root = join(directory, "realdata");
    await mkdir(join(root, "scripts/oracle"), { recursive: true });
    await copyFile("scripts/realdata.sh", join(root, "scripts/realdata.sh"));
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const command of ["npm", "node"])
      await writeFile(
        join(bin, command),
        `#!/usr/bin/env bash\n[ -n "\${DATABASE_URL:-}" ] && printf 'DATABASE_URL=%s ' "$DATABASE_URL"\nprintf '%s %s\\n' '${command}' "$*"\n`,
      );
    await writeFile(
      join(root, BUILDER),
      `#!/usr/bin/env bash\necho "builder $*" >&2\necho postgres://built/db\n`,
    );
    for (const file of ["npm", "node"]) await chmod(join(bin, file), 0o755);
    await chmod(join(root, BUILDER), 0o755);
    const run = (args) =>
      spawnSync("bash", [join(root, "scripts/realdata.sh"), ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENPLANS_PRICE_CHECK_DATABASE_URL: "",
          DATABASE_URL: "",
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
    const price = (stdout) =>
      stdout.split("\n").filter((l) => l.includes("medicare-part-d-price"));
    for (const args of [
      ["--with-price-check"],
      ["--year", "2026", "--with-price-check"],
      ["--with-price-check", "--year", "2026"],
    ]) {
      const result = run(args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("builder build --year 2026\n");
      expect(price(result.stdout)).toEqual([
        "DATABASE_URL=postgres://built/db node scripts/oracle/medicare-part-d-price.mjs --year 2026 --cached",
      ]);
    }
    const plain = run(["--year", "2026"]);
    expect(plain.stderr).toBe("");
    expect(price(plain.stdout)).toEqual([
      "node scripts/oracle/medicare-part-d-price.mjs --year 2026 --cached --optional",
    ]);
    for (const args of [
      ["--with-price-check", "--with-price-check"],
      ["--year", "2026", "--year", "2027"],
      ["--price-check"],
    ]) {
      const result = run(args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("Usage:");
    }
  });
});

// SYNTHETIC mini-archive for the subset script.
const row = (...fields) => fields.join("|");
const text = (lines) => Buffer.from(lines.join("\r\n") + "\r\n");
const member = (name, lines) => zip({ [`${name}.txt`]: text(lines) });
const PLAN_HEAD =
  "CONTRACT_ID|PLAN_ID|SEGMENT_ID|CONTRACT_NAME|PLAN_NAME|FORMULARY_ID|PREMIUM|DEDUCTIBLE|MA_REGION_CODE|PDP_REGION_CODE|STATE|COUNTY_CODE|SNP|PLAN_SUPPRESSED_YN";
const plan = (c, p, s, f, county) =>
  row(
    c,
    p,
    s,
    "Synthetic",
    "Synthetic",
    f,
    "1",
    "0",
    "",
    "01",
    "TX",
    county,
    "0",
    "N",
  );
const FORM_HEAD =
  "FORMULARY_ID|FORMULARY_VERSION|CONTRACT_YEAR|RXCUI|NDC|TIER_LEVEL_VALUE|QUANTITY_LIMIT_YN|QUANTITY_LIMIT_AMOUNT|QUANTITY_LIMIT_DAYS|PRIOR_AUTHORIZATION_YN|STEP_THERAPY_YN|SELECTED_DRUG_YN";
const drug = (f, ndc) =>
  row(f, "1", "2026", "1", ndc, "1", "N", "", "", "N", "N", "N");
const PRICE_HEAD = "CONTRACT_ID|PLAN_ID|SEGMENT_ID|NDC|DAYS_SUPPLY|UNIT_COST";
const price = (c, s, ndc) => row(c, "001", s, ndc, "30", "1.00");
const COUNTY_HEAD =
  "COUNTY_CODE|STATENAME|COUNTY|MA_REGION_CODE|MA_REGION|PDP_REGION_CODE|PDP_REGION";

function archive() {
  return zip({
    "plan information  PPUF_2026Q3.zip": member(
      "plan information  PPUF_2026Q3",
      [
        PLAN_HEAD,
        plan("S9001", "001", "000", "F1", "48201"),
        plan("S9001", "001", "000", "F1", "48202"),
        plan("S9002", "001", "000", "F2", "48201"),
        plan("S9001", "001", "001", "F3", "48201"),
      ],
    ),
    "basic drugs formulary file  PPUF_2026Q3.zip": member(
      "basic drugs formulary file  PPUF_2026Q3",
      [
        FORM_HEAD,
        drug("F1", "90000000001"),
        drug("F2", "90000000002"),
        drug("F2", "90000000009"),
        drug("F3", "90000000003"),
      ],
    ),
    "pricing file PPUF_2026Q3.zip": member("pricing file PPUF_2026Q3", [
      PRICE_HEAD,
      price("S9001", "000", "90000000001"),
      price("S9002", "000", "90000000002"),
      price("S9001", "001", "90000000003"),
    ]),
    "pharmacy networks file  PPUF_2026Q3 part 1.zip": member(
      "pharmacy networks file  PPUF_2026Q3 part 1",
      [
        "CONTRACT_ID|PLAN_ID|SEGMENT_ID|PHARMACY_NUMBER",
        row("S9001", "001", "000", "1"),
      ],
    ),
    "pharmacy networks file  PPUF_2026Q3 part 2.zip": member(
      "pharmacy networks file  PPUF_2026Q3 part 2",
      [
        "CONTRACT_ID|PLAN_ID|SEGMENT_ID|PHARMACY_NUMBER",
        row("S9002", "001", "000", "2"),
      ],
    ),
    "geographic locator file  PPUF_2026Q3.zip": member(
      "geographic locator file PPUF_2026Q3",
      [COUNTY_HEAD, row("48201", "Texas", "Harris", "", "", "22", "Texas")],
    ),
    "sample files PPUF_2026Q3.zip": member("pricing file sample PPUF_2026Q3", [
      PRICE_HEAD,
    ]),
  });
}

describe("price-check-subset.py (synthetic archive)", () => {
  let source, cases, out;
  beforeAll(async () => {
    source = join(directory, "SPUF_synthetic.zip");
    await writeFile(source, archive());
    cases = join(directory, "cases.json");
    // One sample plan (segment 0) and one NDC listed only on another plan's formulary.
    await writeFile(
      cases,
      JSON.stringify({
        cases: [
          { plan_key: "S9001-001-0", ndc: "90000000001" },
          { plan_key: "S9001-001-0", ndc: "90000000009" },
        ],
      }),
    );
    out = join(directory, "subset");
  });
  const cut = (args = []) =>
    spawnSync(
      "python3",
      ["-I", SUBSET, source, "--cases", cases, "--output", out, ...args],
      { encoding: "utf8" },
    );
  const read = async (name) =>
    spawnSync("python3", [
      "-I",
      "-c",
      `import zipfile,io,sys
z=zipfile.ZipFile(sys.argv[1]); m=zipfile.ZipFile(io.BytesIO(z.read(sys.argv[2])))
sys.stdout.write(m.read(m.namelist()[0]).decode())`,
      join(out, "subset.zip"),
      name,
    ]).stdout.toString();

  it("keeps the sample plans' rows and the sample NDCs, copies the rest and records member hashes", async () => {
    const first = cut();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/^built price-check subset: 1 plans/);
    const manifest = JSON.parse(
      await readFile(join(out, "subset.json"), "utf8"),
    );
    expect(manifest.plans).toEqual(["S9001-001-0"]);
    expect(manifest.formularies).toEqual(["F1"]);
    const byName = Object.fromEntries(
      manifest.members.map((m) => [m.member, m]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      "basic drugs formulary file  PPUF_2026Q3.zip",
      "geographic locator file  PPUF_2026Q3.zip",
      "pharmacy networks file  PPUF_2026Q3 part 1.zip",
      "pharmacy networks file  PPUF_2026Q3 part 2.zip",
      "plan information  PPUF_2026Q3.zip",
      "pricing file PPUF_2026Q3.zip",
      "sample files PPUF_2026Q3.zip",
    ]);
    for (const m of manifest.members)
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byName["sample files PPUF_2026Q3.zip"].action).toBe("dropped");
    expect(byName["geographic locator file  PPUF_2026Q3.zip"]).toMatchObject({
      action: "copied",
    });
    const geo = byName["geographic locator file  PPUF_2026Q3.zip"];
    expect(geo.output_sha256).toBe(geo.sha256);
    expect(byName["plan information  PPUF_2026Q3.zip"]).toMatchObject({
      action: "plan",
      rows_read: 4,
      rows_kept: 2,
    });
    expect(
      byName["pharmacy networks file  PPUF_2026Q3 part 2.zip"].rows_kept,
    ).toBe(0);
    // Segment 001 of the same plan and the other contract stay out.
    expect(await read("pricing file PPUF_2026Q3.zip")).toBe(
      `${PRICE_HEAD}\r\n${price("S9001", "000", "90000000001")}\r\n`,
    );
    expect(await read("basic drugs formulary file  PPUF_2026Q3.zip")).toBe(
      [FORM_HEAD, drug("F1", "90000000001"), drug("F2", "90000000009")]
        .map((l) => `${l}\r\n`)
        .join(""),
    );
    expect(manifest.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses the subset on a second run and gives the same bytes when rebuilt", async () => {
    const before = await readFile(join(out, "subset.zip"));
    const mtime = (await stat(join(out, "subset.zip"))).mtimeMs;
    const manifest = await readFile(join(out, "subset.json"), "utf8");
    const again = cut();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).toMatch(/^reused/);
    expect((await stat(join(out, "subset.zip"))).mtimeMs).toBe(mtime);
    expect(await readFile(join(out, "subset.json"), "utf8")).toBe(manifest);
    // A damaged subset is rebuilt, to the same bytes.
    await writeFile(join(out, "subset.zip"), "damaged");
    const rebuilt = cut();
    expect(rebuilt.stderr).toMatch(/^built/);
    expect((await readFile(join(out, "subset.zip"))).equals(before)).toBe(true);
    // Another source hash or another sample is a different subset.
    expect(cut(["--source-sha256", "0".repeat(64)]).stderr).toMatch(/^built/);
    expect(cut().stderr).toMatch(/^built/);
    expect(cut().stderr).toMatch(/^reused/);
  });

  it("fails when a sample plan is not in the archive", async () => {
    const missing = join(directory, "missing.json");
    await writeFile(
      missing,
      JSON.stringify({ cases: [{ plan_key: "S9999-001-0", ndc: "1" }] }),
    );
    const result = spawnSync(
      "python3",
      [
        "-I",
        SUBSET,
        source,
        "--cases",
        missing,
        "--output",
        join(directory, "m"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("S9999");
  });
});
