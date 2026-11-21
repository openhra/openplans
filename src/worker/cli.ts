#!/usr/bin/env node
// Package and inventory commands must not evaluate the worker's plugin/source module graph.
const args = process.argv.slice(2);
if (
  args[0] === "plugin" &&
  [
    "lock",
    "verify",
    "pack",
    "install",
    "search",
    "list",
    "update",
    "remove",
    "bundle",
  ].includes(args[1] ?? "")
) {
  if (
    args[1] === "pack" ||
    args[1] === "install" ||
    ["search", "list", "update", "remove", "bundle"].includes(args[1] ?? "") ||
    (args[1] === "verify" && args[2] === "--local")
  ) {
    const { runPackageCommand } =
      await import("./commands/plugin-package-cli.js");
    process.exitCode = await runPackageCommand(args, {
      out: (line) => console.log(line),
      error: (line) => console.error(line),
    });
  } else {
    const { runPluginInventory } = await import("../plugins/lock-cli.js");
    process.exitCode = await runPluginInventory(args.slice(1));
  }
} else {
  await import("./runtime.js");
}
export {};
