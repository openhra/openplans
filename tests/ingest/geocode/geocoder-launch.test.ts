import { it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Synthetic command shims and database markers. No Docker daemon or mount is used.
async function harness(running: boolean, volume = "tx", finished = false) {
  const root = await mkdtemp(join(tmpdir(), "open-geocoder-launch-")),
    bin = join(root, "bin"),
    mount = join(root, "mount");
  await mkdir(bin);
  await mkdir(join(mount, "postgres"), { recursive: true });
  await writeFile(join(mount, "postgres", "PG_VERSION"), "16\n");
  if (finished) await writeFile(join(mount, "postgres", "import-finished"), "");
  await writeFile(join(root, "image"), "");
  const commands: Record<string, string> = {
    docker: `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_COMMAND_LOG"\ncase "$*" in
  *' inspect '*) echo 'openplans-geocoder-${volume}-261107-ext4 ${running}';;
  *' exec '*) exit 1;;
  *' compose '*) exit 0;;
  *) exit 91;;
esac\n`,
    colima: `#!/bin/sh\ncase "$*" in
  *' df '*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/synthetic 500000000 1 499999999 1%% /synthetic\\n';;
  *) exec /bin/sh -s -- "$TEST_IMAGE" "$TEST_MOUNT" up;;
esac\n`,
    df: `#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/synthetic 500000000 1 499999999 1%% /synthetic\\n'\n`,
    python3: `#!/bin/sh\ncase "$1" in -c) echo 20261107T212136Z;; esac\n`,
    mountpoint: "#!/bin/sh\nexit 0\n",
  };
  for (const [name, body] of Object.entries(commands))
    await writeFile(join(bin, name), body, { mode: 0o755 });
  return {
    run: () =>
      spawnSync("bash", ["src/ingest/geocode/geocoder.sh", "up"], {
        cwd: new URL("../../../", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          OPENPLANS_DATA_DIR: root,
          OPENPLANS_GEOCODER_STATE: "tx",
          OPENPLANS_GEOCODER_SNAPSHOT: "261107",
          TEST_IMAGE: join(root, "image"),
          TEST_MOUNT: mount,
          TEST_COMMAND_LOG: join(root, "commands"),
        },
      }),
    commands: () => readFile(join(root, "commands"), "utf8"),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

it("leaves the matching running unfinished import unchanged", async () => {
  const h = await harness(true);
  try {
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("container unchanged");
    expect(await h.commands()).not.toContain(" compose ");
  } finally {
    await h.close();
  }
});
it("refuses to replace a different running unfinished state", async () => {
  const h = await harness(true, "fl");
  try {
    const result = h.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to replace");
    expect(await h.commands()).not.toContain(" compose ");
  } finally {
    await h.close();
  }
});
it("negative control: refuses a stopped partial database while a completed marker permits startup", async () => {
  for (const finished of [false, true]) {
    const h = await harness(false, "tx", finished);
    try {
      const result = h.run();
      expect(result.status, result.stderr).toBe(finished ? 0 : 1);
      expect((await h.commands()).includes(" compose ")).toBe(finished);
      if (!finished)
        expect(result.stderr).toContain("explicit Nominatim continuation");
    } finally {
      await h.close();
    }
  }
});
