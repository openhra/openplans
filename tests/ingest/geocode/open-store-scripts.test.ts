import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../../src/ingest/geocode/download-open.py", import.meta.url),
);

it("download-open.py reuses the store copy geocoder.sh names and leaves raw/ alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-geocoder-store-copy-"));
  const data = join(root, "data"),
    copy = join(data, "work", "open-geocoder", "from-store"),
    directory = join(copy, "tx", "261107");
  try {
    await mkdir(directory, { recursive: true });
    const content = "synthetic store copy for SHA-256 control";
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
      OPENPLANS_DATA_DIR: data,
      HTTPS_PROXY: "http://127.0.0.1:1",
    };
    expect(
      execFileSync("python3", [script, "TX", "--snapshot", "261107"], {
        env: { ...env, OPENPLANS_OPEN_GEOCODER_RAW_DIR: copy },
        encoding: "utf8",
      }).trim(),
    ).toBe(join(directory, "metadata.json"));
    expect(await readdir(data)).toEqual(["work"]);
    // A relative override is refused before anything is created.
    expect(() =>
      execFileSync("python3", [script, "TX", "--snapshot", "261107"], {
        env: { ...env, OPENPLANS_OPEN_GEOCODER_RAW_DIR: "relative/copy" },
        stdio: "pipe",
      }),
    ).toThrow();
    expect(await readdir(data)).toEqual(["work"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
