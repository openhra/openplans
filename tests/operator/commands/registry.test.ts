import { expect, it } from "vitest";
import { z } from "zod";
import {
  emptyRegistries,
  emptySeen,
  stagingRegistrar,
} from "../../../src/plugins/registries.js";
import { loadPlugins } from "../../../src/plugins/loader.js";
import { loadConfig } from "../../../src/config/index.js";
import { command, manifest, register } from "./fixture.js";

it("retains one command registry on API and worker, while stdio stays read-only", () => {
  expect(register(command(), "api").operatorCommands).toHaveLength(1);
  expect(register(command(), "worker").operatorCommands).toHaveLength(1);
  expect(register(command(), "stdio").operatorCommands).toHaveLength(0);
});
it("refuses undeclared kinds, foreign/prefix-adjacent tables, loose schemas, unsafe deadlines and missing audit", () => {
  for (const change of [
    { tables: ["plg_other_state"] },
    { tables: ["plg_msotx_state"] },
    { tables: ["plan"] },
    { inputSchema: z.object({ allowed: z.boolean() }) },
    { outputSchema: z.object({ allowed: z.boolean() }) },
    { timeoutMs: 15_001 },
    { sources: [] },
    { store: { ...command().store, audit: undefined } },
  ]) {
    const registrar = stagingRegistrar(
      emptyRegistries(),
      manifest,
      "api",
      emptySeen(),
    );
    expect(() =>
      registrar.context.operatorCommands!.add({
        ...command(),
        ...change,
      } as ReturnType<typeof command>),
    ).toThrow("plugin_registration_invalid");
    expect(registrar.refusal()?.code).toBe("plugin_registration_invalid");
  }
  const registrar = stagingRegistrar(
    emptyRegistries(),
    { ...manifest, kinds: [] },
    "worker",
    emptySeen(),
  );
  expect(() => registrar.context.operatorCommands!.add(command())).toThrow(
    "plugin_kind_undeclared",
  );
});
it("closes registration, refuses collisions and latches caught refusals", () => {
  const staging = emptyRegistries();
  const registrar = stagingRegistrar(staging, manifest, "api", emptySeen());
  registrar.context.operatorCommands!.add(command());
  expect(() => registrar.context.operatorCommands!.add(command())).toThrow(
    "plugin_registration_collision",
  );
  expect(registrar.refusal()).toBeDefined();
  registrar.close();
  expect(() => registrar.context.operatorCommands!.add(command())).toThrow(
    "Registries close",
  );
  expect(Object.isFrozen(staging.operatorCommands[0]!.spec.sources)).toBe(true);
});
it("requires publisher authority for publication and preserves class-based owner store hooks", () => {
  expect(() => register({ ...command(), publication: true })).toThrow(
    "plugin_registration_invalid",
  );
  const original = command();
  class Store {
    lookup = original.store.lookup;
    current = original.store.current;
    async audit(...args: Parameters<typeof original.store.audit>) {
      return original.store.audit(...args);
    }
    async remember(...args: Parameters<typeof original.store.remember>) {
      return original.store.remember(...args);
    }
  }
  const registered = register({ ...original, store: new Store() });
  expect(typeof registered.operatorCommands[0]!.spec.store.audit).toBe(
    "function",
  );
});
it("loads with no command effects during setup and leaves disabled admin absent", async () => {
  const loaded = await loadPlugins(
    loadConfig(
      {},
      {
        version: 1,
        plugins: [{ package: "@openplans/plugin-admin", enabled: false }],
      },
    ),
    "api",
    { env: {} },
  );
  expect(loaded.registries.operatorCommands).toEqual([]);
  expect(loaded.registries.routes).toEqual([]);
  await loaded.teardown();
});
it("loads the same frozen command registration on both hosts without setup SQL", async () => {
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: [
        { package: new URL("./plugin-fixture.ts", import.meta.url).pathname },
      ],
    },
  );
  for (const host of ["api", "worker"] as const) {
    const loaded = await loadPlugins(config, host, {
      env: {},
      exit: () => {
        throw new Error("fixture refused");
      },
    });
    expect(loaded.registries.operatorCommands).toHaveLength(1);
    expect(loaded.registries.operatorCommands[0]!.spec.name).toBe(
      "msot.synthetic",
    );
    expect(loaded.registries.mcpTools).toEqual([]);
    expect(Object.isFrozen(loaded.registries.operatorCommands)).toBe(true);
    await loaded.teardown();
  }
});
