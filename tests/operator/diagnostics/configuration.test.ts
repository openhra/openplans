import { expect, it } from "vitest";
import { loadConfig } from "../../../src/config/index.js";
import { configurationSettings } from "../../../src/config/diagnostics.js";
import type { OperatorSetting } from "@openplans/plugin-sdk";

const marker = "synthetic-private-config-marker";
const config = loadConfig(
  {
    PORT: "4321",
    DATABASE_URL: marker,
    OPENPLANS_CACHE_URL: marker,
    OPENPLANS_OPERATOR_TOKEN: marker,
    OPENPLANS_DATA_DIR: `/private/${marker}`,
  },
  {
    version: 1,
    listen: { port: 1234, host: marker },
    cache: { enabled: false, maxMb: 0 },
    plugins: [
      { package: "@openplans/plugin-msot", options: { private: marker } },
    ],
  },
);

function safeSettings(rows: readonly OperatorSetting[]) {
  expect(
    JSON.stringify(rows).includes(marker),
    "private config was exposed",
  ).toBe(false);
  expect(rows.some((row) => row.key.includes("options"))).toBe(false);
  expect(rows.find((row) => row.key === "listen.port")).toMatchObject({
    displayValue: 4321,
    source: "environment",
    writable: false,
    process: "api",
    appliedAt: "startup",
  });
  expect(rows.find((row) => row.key === "cache.enabled")).toMatchObject({
    displayValue: false,
    source: "file",
  });
  expect(rows.find((row) => row.key === "cache.maxMb")).toMatchObject({
    displayValue: 0,
    source: "file",
  });
  expect(rows.find((row) => row.key === "cache.provider")).toMatchObject({
    displayValue: "valkey",
    source: "environment",
  });
}

it("records actual environment, file and default precedence without retaining raw inputs", () => {
  const rows = configurationSettings(config, "api");
  safeSettings(rows);
  expect(rows.find((row) => row.key === "public.compat")).toMatchObject({
    displayValue: true,
    source: "default",
  });
  expect(rows.find((row) => row.key === "tokens.operator")).toMatchObject({
    displayValue: "configured",
    source: "environment",
    reason: "secret_presence_only",
  });
  expect(rows.find((row) => row.key === "tokens.api")).toMatchObject({
    displayValue: "unset",
    source: "default",
  });
  expect(Object.isFrozen(rows)).toBe(true);
});

it("keeps unknown origin distinct for a config not resolved by loadConfig", () => {
  expect(
    configurationSettings({ ...config }, "worker").every(
      (row) => row.source === "unknown",
    ),
  ).toBe(true);
  const custom = loadConfig({}, { version: 1, db: { provider: marker } });
  expect(
    configurationSettings(custom, "api").find(
      (row) => row.key === "db.provider",
    ),
  ).toMatchObject({ displayValue: null, reason: "unsupported_value" });
});

it("rejects raw-config/options, hidden environment override, false and zero mutants", () => {
  const rows = configurationSettings(config, "api");
  safeSettings(rows);
  const mutate = (key: string, patch: Partial<OperatorSetting>) =>
    rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
  const mutants = [
    [...rows, { ...rows[0]!, key: "plugins.options", displayValue: marker }],
    mutate("listen.port", { source: "file", displayValue: 1234 }),
    mutate("cache.enabled", { displayValue: null }),
    mutate("cache.maxMb", { displayValue: null }),
  ];
  for (const mutant of mutants) expect(() => safeSettings(mutant)).toThrow();
});
