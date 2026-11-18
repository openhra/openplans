import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginManifest, ScheduleSpec } from "@openplans/plugin-sdk";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import * as Registries from "../../src/plugins/registries.js";
import type { PluginHost } from "../../src/plugins/registries.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";

// Synthetic plugin and schedules only.
const manifest: PluginManifest = {
  name: "@synthetic/cron-registration",
  version: "0.0.1",
  apiVersion: "0.1",
  kinds: ["schedules"],
};
const schedule = (cron: string): ScheduleSpec => ({
  name: "synthetic-tick",
  cron,
  command: ["synthetic", "tick"],
  maxRunMs: 1_000,
});
const hosts: PluginHost[] = ["api", "worker", "stdio"];

function registrar(host: PluginHost, module = Registries) {
  const staging = module.emptyRegistries();
  const seen = module.emptySeen();
  return {
    ...module.stagingRegistrar(staging, manifest, host, seen),
    staging,
    seen,
  };
}

describe.each(hosts)("schedule registration on %s", (host) => {
  it.each([
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * 32 * *",
    "* * * 0 *",
    "* * * 13 *",
    "* * * * 8",
    "5-1 * * * *",
    "1-60 * * * *",
    "1-2-3 * * * *",
    "*/0 * * * *",
    "*/60 * * * *",
    "*/-1 * * * *",
    "*/1.5 * * * *",
    "*/5/2 * * * *",
    "1/ * * * *",
    "1,,2 * * * *",
    "* * * JAN *",
    "* * * * MON",
    "* * ? * *",
    "* * L * *",
    "* * 1W * *",
    "* * * * 1#2",
    "@hourly",
  ])("refuses %j before claiming its name or staging it", (cron) => {
    const registration = registrar(host);
    expect(() => registration.context.schedules.add(schedule(cron))).toThrow(
      Registries.PluginRefusal,
    );
    expect(registration.refusal()).toMatchObject({
      plugin: manifest.name,
      code: "plugin_registration_invalid",
      message: "plugin_registration_invalid",
    });
    expect(registration.staging.schedules).toEqual([]);
    expect(registration.seen.schedules.has("synthetic-tick")).toBe(false);
  });

  it.each([null, undefined, 5, {}])("refuses non-string cron %j", (cron) => {
    const registration = registrar(host);
    expect(() =>
      registration.context.schedules.add({
        ...schedule("* * * * *"),
        cron: cron as never,
      }),
    ).toThrow(Registries.PluginRefusal);
    expect(registration.refusal()?.code).toBe("plugin_registration_invalid");
  });

  it.each([
    "* * * * *",
    "*/15 9-17 * * 1-5",
    "5/20 0,12 1,15 1-12/2 0,7",
    "59 23 31 12 7",
    "0 0 13 * 3",
    "  0\t12 * * *  ",
  ])("accepts supported UTC expression %j", (cron) => {
    const registration = registrar(host);
    const spec = schedule(cron);
    expect(() => registration.context.schedules.add(spec)).not.toThrow();
    expect(registration.refusal()).toBeUndefined();
    expect(registration.staging.schedules).toEqual(
      host === "worker" ? [{ plugin: manifest.name, spec }] : [],
    );
  });

  it("stops plugin loading even if setup catches the cron refusal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openplans-cron-load-"));
    const lines: string[] = [];
    const exit = new Error("synthetic startup exit");
    try {
      await writeFile(
        join(directory, "plugin.mjs"),
        `export default {
          manifest: ${JSON.stringify(manifest)},
          setup(ctx) {
            try { ctx.schedules.add(${JSON.stringify(schedule("60 * * * *"))}); }
            catch { /* The loader must still refuse this plugin. */ }
          }
        };`,
      );
      const config = loadConfig(
        {},
        {
          version: 1,
          plugins: [{ package: "./plugin.mjs" }],
        },
      );
      const active = Registries.currentRegistries();
      await expect(
        loadPlugins(config, host, {
          baseDirectory: directory,
          manifestPaths: [],
          env: {},
          writeLog: (line) => lines.push(line),
          exit: (code) => {
            expect(code).toBe(1);
            throw exit;
          },
        }),
      ).rejects.toBe(exit);
      expect(lines.map((line) => JSON.parse(line) as unknown)).toContainEqual({
        plugin: manifest.name,
        code: "plugin_registration_invalid",
      });
      expect(Registries.currentRegistries()).toBe(active);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("mutant: removing cron parsing admits a malformed five-field schedule", async () => {
  const spec = schedule("60 * * * *");
  const original = registrar("worker");
  expect(() => original.context.schedules.add(spec)).toThrow(
    Registries.PluginRefusal,
  );
  const mutant = await plantMutant(
    new URL("../../src/plugins/registries.ts", import.meta.url),
    "parseCron(spec.cron);",
    "",
  );
  try {
    const module = (await import(
      pathToFileURL(mutant.path).href
    )) as typeof Registries;
    const registration = registrar("worker", module);
    expect(() => registration.context.schedules.add(spec)).not.toThrow();
    expect(registration.refusal()).toBeUndefined();
    expect(registration.staging.schedules).toEqual([
      { plugin: manifest.name, spec },
    ]);
  } finally {
    await mutant.cleanup();
  }
});
