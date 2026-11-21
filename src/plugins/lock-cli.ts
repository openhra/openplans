import type { WorkerOutput } from "../worker/commands.js";
import { dirname } from "node:path";
import { loadConfig, currentEnvironment } from "../config/index.js";
import type { Environment } from "../config/index.js";
import {
  pluginLockPath,
  readPluginLock,
  lockPlugins,
  verifyPluginLock,
} from "./lock.js";
import type { PluginLock } from "./lock.js";
import { PluginRefusal } from "./refusal.js";

/** Runs before the worker loads plugins or opens storage. */
export async function runPluginInventory(
  args: readonly string[],
  env: Environment = currentEnvironment(),
  output: WorkerOutput = {
    out: (line) => console.log(line),
    error: (line) => console.error(line),
  },
): Promise<number> {
  try {
    if (!(
      (["lock", "list"].includes(args[0] ?? "") && args.length === 1) ||
      (args[0] === "verify" &&
        (args.length === 1 || (args.length === 2 && args[1] === "--json")))
    ))
      throw new Error("usage");
    const config = loadConfig(env);
    const base = env.OPENPLANS_CONFIG
      ? dirname(env.OPENPLANS_CONFIG)
      : process.cwd();
    let lock: PluginLock;
    let code: string;
    if (args[0] === "lock") {
      lock = await lockPlugins(config, base, env);
      code = "plugin_lock_written";
    } else if (args[0] === "list") {
      lock = await readPluginLock(pluginLockPath(config, base));
      code = "plugin_list";
    } else {
      lock = await verifyPluginLock(config, base, env);
      code = "plugin_verify_pass";
    }
    output.out(
      JSON.stringify({
        code,
        approval: config.plugins.approvedList ? "configured" : "required",
        packages: lock.packages,
      }),
    );
    return 0;
  } catch (error) {
    output.error(
      JSON.stringify({
        plugin: error instanceof PluginRefusal ? error.plugin : "openplans",
        code: "plugin_inventory_refused",
        reason:
          error instanceof PluginRefusal
            ? error.reason
            : "invalid_inventory_or_arguments",
      }),
    );
    return 1;
  }
}
