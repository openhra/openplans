import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("reuses a hash-verified regional cache offline and rejects a corrupted cached extract", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-geocoder-download-"));
  const source = fileURLToPath(
    new URL("../../../src/ingest/geocode/download-open.py", import.meta.url),
  );
  const project = join(root, "extracted"),
    script = join(project, "src", "ingest", "geocode", "download-open.py");
  const dataRoot = join(root, "data"),
    directory = join(dataRoot, "raw", "open-geocoder", "tx", "261107");
  try {
    await mkdir(join(project, "src", "ingest", "geocode"), { recursive: true });
    await mkdir(join(project, ".git"));
    await writeFile(script, await readFile(source));
    await mkdir(directory, { recursive: true });
    const content = "synthetic cached transfer for SHA-256 control";
    await writeFile(join(directory, "data.osm.pbf"), content);
    await writeFile(
      join(directory, "metadata.json"),
      JSON.stringify({
        state: "TX",
        snapshot: "261107",
        sha256: createHash("sha256").update(content).digest("hex"),
      }),
    );
    const env = {
      ...process.env,
      OPENPLANS_DATA_DIR: dataRoot,
      HTTPS_PROXY: "http://127.0.0.1:1",
    };
    expect(
      execFileSync("python3", [script, "TX", "--snapshot", "261107"], {
        env,
        encoding: "utf8",
      }),
    ).toContain("metadata.json");
    await writeFile(join(directory, "data.osm.pbf"), content + " corrupt");
    expect(() =>
      execFileSync("python3", [script, "TX", "--snapshot", "261107"], {
        env,
        stdio: "pipe",
      }),
    ).toThrow();
    expect(await readFile(join(directory, "data.osm.pbf"), "utf8")).toBe(
      content + " corrupt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a data directory inside another checkout before creating download files", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-geocoder-checkout-"));
  const script = fileURLToPath(
    new URL("../../../src/ingest/geocode/download-open.py", import.meta.url),
  );
  try {
    await mkdir(join(root, ".git"));
    expect(() =>
      execFileSync("python3", [script, "TX", "--snapshot", "261107"], {
        env: { ...process.env, OPENPLANS_DATA_DIR: join(root, "data") },
        stdio: "pipe",
      }),
    ).toThrow();
    await expect(
      readFile(
        join(
          root,
          "data",
          "raw",
          "open-geocoder",
          "tx",
          "261107",
          "metadata.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reuses a prepared address index without Docker and rejects derivative corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-geocoder-prepared-")),
    project = join(root, "project"),
    data = join(root, "data");
  const scriptDir = join(project, "src", "ingest", "geocode"),
    raw = join(data, "raw", "open-geocoder", "tx", "261107"),
    work = join(data, "work", "open-geocoder");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  try {
    await mkdir(scriptDir, { recursive: true });
    await mkdir(raw, { recursive: true });
    await mkdir(work, { recursive: true });
    await mkdir(join(root, "bin"));
    for (const name of ["download-open.py", "prepare-open.py"])
      await writeFile(
        join(scriptDir, name),
        await readFile(
          new URL("../../../src/ingest/geocode/" + name, import.meta.url),
        ),
      );
    const python = execFileSync(
      "python3",
      ["-c", "import sys; print(sys.executable)"],
      { encoding: "utf8" },
    ).trim();
    await symlink(python, join(root, "bin", "python3"));
    const original = "synthetic original cache",
      index = "synthetic derived cache";
    await writeFile(join(raw, "data.osm.pbf"), original);
    await writeFile(
      join(raw, "metadata.json"),
      JSON.stringify({
        state: "TX",
        snapshot: "261107",
        sha256: sha(original),
        data_timestamp: "2026-11-07T21:21:36+00:00",
      }),
    );
    await writeFile(join(work, "tx-261107-addresses.osm.pbf"), index);
    const manifest = {
      raw_sha256: sha(original),
      index_sha256: sha(index),
      profile: "nominatim-address-v1",
      object_timestamp: "2026-11-07T21:20:56Z",
      filters: [
        "nwr/addr:*",
        "nwr/place",
        "wr/highway",
        "wr/boundary",
        "r/type=associatedStreet",
      ],
    };
    await writeFile(
      join(work, "tx-261107-address-index.json"),
      JSON.stringify(manifest),
    );
    const env = {
      ...process.env,
      OPENPLANS_DATA_DIR: data,
      PATH: join(root, "bin"),
    };
    expect(
      execFileSync(
        python,
        [join(scriptDir, "prepare-open.py"), "TX", "--snapshot", "261107"],
        { env, encoding: "utf8" },
      ),
    ).toContain("address-index.json");
    const legacy: Partial<typeof manifest> = { ...manifest };
    delete legacy.object_timestamp;
    await writeFile(
      join(work, "tx-261107-address-index.json"),
      JSON.stringify(legacy),
    );
    await writeFile(
      join(root, "bin", "docker"),
      `#!/bin/sh\ncase "$*" in
      *'image inspect'*) exit 0;;
      *'fileinfo'*) printf '%s\\n' '{"data":{"timestamp":{"last":"2026-11-07T21:20:56Z"}}}';;
      *) exit 91;;
    esac\n`,
      { mode: 0o755 },
    );
    expect(
      execFileSync(
        python,
        [join(scriptDir, "prepare-open.py"), "TX", "--snapshot", "261107"],
        { env, encoding: "utf8" },
      ),
    ).toContain("address-index.json");
    expect(
      JSON.parse(
        await readFile(join(work, "tx-261107-address-index.json"), "utf8"),
      ).object_timestamp,
    ).toBe(manifest.object_timestamp);
    expect(
      await readFile(join(work, "tx-261107-addresses.osm.pbf"), "utf8"),
    ).toBe(index);
    await rm(join(root, "bin", "docker"));
    await writeFile(
      join(work, "tx-261107-address-index.json"),
      JSON.stringify({ ...manifest, object_timestamp: "2026-11-08T00:00:00Z" }),
    );
    expect(() =>
      execFileSync(
        python,
        [join(scriptDir, "prepare-open.py"), "TX", "--snapshot", "261107"],
        { env, stdio: "pipe" },
      ),
    ).toThrow();
    await writeFile(
      join(work, "tx-261107-address-index.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      join(work, "tx-261107-addresses.osm.pbf"),
      index + " corrupt",
    );
    expect(() =>
      execFileSync(
        python,
        [join(scriptDir, "prepare-open.py"), "TX", "--snapshot", "261107"],
        { env, stdio: "pipe" },
      ),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
