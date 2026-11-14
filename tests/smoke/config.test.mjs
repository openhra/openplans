import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("./check.mjs", import.meta.url));
// Synthetic Compose output: no daemon or external service is used by these controls.
const config = () => ({
  services: {
    db: {
      image: "openplans-db:local",
      ports: [{ host_ip: "127.0.0.1", target: 5432 }],
    },
    api: {
      image: "openplans:local",
      environment: { OPENPLANS_API_TOKEN: "" },
      ports: [{ host_ip: "127.0.0.1", target: 3000 }],
    },
    worker: {
      image: "openplans:local",
      volumes: [
        { target: "/data/raw", read_only: true },
        { target: "/data/work" },
        { target: "/data/reports" },
      ],
    },
  },
});
function check(value, images = {}) {
  const env = { ...process.env, ...images };
  if (!images.OPENPLANS_IMAGE) delete env.OPENPLANS_IMAGE;
  if (!images.OPENPLANS_DB_IMAGE) delete env.OPENPLANS_DB_IMAGE;
  return spawnSync(process.execPath, [checker, "config"], {
    input: JSON.stringify(value),
    env,
    encoding: "utf8",
    timeout: 5_000,
  });
}
// Synthetic per-run tags, shaped like the ones scripts/smoke.sh makes.
const runImages = {
  OPENPLANS_IMAGE: "openplans:smoke-h2-20261113000000-1",
  OPENPLANS_DB_IMAGE: "openplans-db:smoke-h2-20261113000000-1",
};
function tagged() {
  const value = config();
  value.services.api.image = runImages.OPENPLANS_IMAGE;
  value.services.worker.image = runImages.OPENPLANS_IMAGE;
  value.services.db.image = runImages.OPENPLANS_DB_IMAGE;
  return value;
}

describe("Docker smoke configuration controls (synthetic)", () => {
  it("accepts native images, loopback ports and a read-only raw cache", () => {
    const result = check(config());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("compose config: native platform");
  });
  it("accepts the per-run image tags smoke exports", () => {
    expect(check(tagged(), runImages).status).toBe(0);
  });
  it.each([
    ["api", "openplans:local"],
    ["worker", "openplans:local"],
    ["db", "openplans-db:local"],
  ])(
    "rejects a %s service left on the shared tag %s during a tagged run",
    (service, image) => {
      const value = tagged();
      value.services[service].image = image;
      expect(check(value, runImages).status).toBe(1);
    },
  );
  it.each([
    [
      "public API",
      (value) => {
        value.services.api.ports[0].host_ip = "0.0.0.0";
      },
    ],
    [
      "public DB",
      (value) => {
        value.services.db.ports[0].host_ip = "::";
      },
    ],
    [
      "emulated DB",
      (value) => {
        value.services.db.platform = "linux/amd64";
      },
    ],
    [
      "writable raw cache",
      (value) => {
        value.services.worker.volumes[0].read_only = false;
      },
    ],
    [
      "missing work mount",
      (value) => {
        value.services.worker.volumes.splice(1, 1);
      },
    ],
    [
      "read-only work mount",
      (value) => {
        value.services.worker.volumes[1].read_only = true;
      },
    ],
    [
      "missing reports mount",
      (value) => {
        value.services.worker.volumes.pop();
      },
    ],
  ])("rejects a deliberately broken %s configuration", (_label, mutate) => {
    const value = config();
    mutate(value);
    expect(check(value).status).toBe(1);
  });
});
