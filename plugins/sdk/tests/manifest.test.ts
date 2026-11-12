import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PLUGIN_API_VERSION, pluginManifestSchema } from "../src/index.js";

const manifest = {
  name: "@openplans/plugin-synthetic",
  version: "1.2.3",
  apiVersion: PLUGIN_API_VERSION,
  kinds: ["routes"],
};

describe("plugin manifest", () => {
  it("accepts a minimal manifest and the experimental API version", () => {
    expect(PLUGIN_API_VERSION).toBe("0.1");
    expect(pluginManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("accepts every registration kind, optional capabilities and a config schema", () => {
    const complete = {
      ...manifest,
      version: "0.1.0-rc.1+build.01",
      kinds: [
        "routes",
        "mcpTools",
        "cacheStores",
        "dbProviders",
        "blobStores",
        "sources",
        "workerCommands",
        "schedules",
        "events",
      ],
      capabilities: {
        network: ["synthetic.example.org"],
        secrets: ["SYNTHETIC_TOKEN"],
        writes: ["staging", "cache", "blobs", "events"],
        operatorRoutes: true,
        hostStatus: true,
      },
      tablePrefix: "synthetic",
      options: z.object({ enabled: z.boolean() }),
    };
    const parsed = pluginManifestSchema.parse(complete);
    expect(parsed).toEqual(complete);
    expect(parsed.options?.safeParse({ enabled: true }).success).toBe(true);
    expect(parsed.options?.safeParse({ enabled: "true" }).success).toBe(false);
  });

  it.each([
    { name: "A-synthetic" },
    { name: "a" },
    { name: "a".repeat(102) },
    { version: "1.2" },
    { version: "01.2.3" },
    { version: "1.2.3-01" },
    { apiVersion: "0.2" },
    { kinds: ["unknown"] },
    { capabilities: { writes: ["database"] } },
    { capabilities: { operatorRoutes: "true" } },
    { capabilities: { hostStatus: "true" } },
    { capabilities: { network: [42] } },
    { tablePrefix: "Synthetic" },
    { tablePrefix: "s" },
    { tablePrefix: "1synthetic" },
    { tablePrefix: "syn_thetic" },
    { tablePrefix: "a".repeat(17) },
    { capabilities: { secrets: "SYNTHETIC_TOKEN" } },
    { capabilities: { unknown: true } },
    { options: {} },
    { unknown: true },
  ])("rejects invalid manifest fields: %j", (invalid) => {
    expect(
      pluginManifestSchema.safeParse({ ...manifest, ...invalid }).success,
    ).toBe(false);
  });

  it.each(["name", "version", "apiVersion", "kinds"])("requires %s", (key) => {
    const incomplete = { ...manifest };
    Reflect.deleteProperty(incomplete, key);
    expect(pluginManifestSchema.safeParse(incomplete).success).toBe(false);
  });
});
