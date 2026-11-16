import { expect, it } from "vitest";

it("loads the built admin plugin by package name", async () => {
  const plugin = await import("@openplans/plugin-admin");
  expect(plugin.default.manifest.name).toBe("@openplans/plugin-admin");
  expect(plugin.createAdminPlugin().manifest.name).toBe(
    "@openplans/plugin-admin",
  );
});
