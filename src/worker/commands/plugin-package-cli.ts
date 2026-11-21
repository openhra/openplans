import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../../config/index.js";
import { pluginLockPath } from "../../plugins/lock.js";
import { dataDirectory } from "../../config/access.js";
import { withVerifiedPackage } from "../../plugins/package/verify.js";
import { installDataPackage } from "../../registry/data/install.js";
import { installPlugin } from "../../plugins/package/install.js";

export interface PackageCommandIo {
  out(message: string): void;
  error(message: string): void;
}
/** Runs before plugin imports or database setup. */
export async function runPackageCommand(
  args: readonly string[],
  io: PackageCommandIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    if (args[0] !== "plugin") throw new Error("Expected worker plugin command");
    const [, command, ...supplied] = args;
    const data = command === "install" && supplied[0] === "--data";
    const rest = data ? supplied.slice(1) : supplied;
    if (
      command === "pack" &&
      rest.length === 3 &&
      rest[0] &&
      rest[1] === "--out" &&
      rest[2]
    ) {
      const { packPlugin } = await import("../../plugins/package/pack.js");
      io.out(JSON.stringify(await packPlugin(rest[0], rest[2])));
      return 0;
    }
    if (
      command === "verify" &&
      rest.length === 2 &&
      rest[0] === "--local" &&
      rest[1]
    ) {
      return await withVerifiedPackage(rest[1], async (_root, verified) => {
        io.out(
          JSON.stringify({
            name: verified.manifest.name,
            version: verified.manifest.version,
            manifestSha256: verified.manifestSha256,
            digest: verified.digest,
            legacySha256: verified.legacySha256,
            evidence: verified.evidence,
            approval: "not_granted",
          }),
        );
        return verified.evidence === "complete" ? 0 : 1;
      });
    }
    const registryCommand =
      ["search", "list", "update", "remove", "bundle"].includes(
        command ?? "",
      ) ||
      (command === "install" &&
        (rest.includes("--registry") ||
          /^(@[^@]+)@([^@]+)$/.test(rest[0] ?? "")));
    if (registryCommand) {
      const { runRegistryCommand } = await import("./plugin-registry-cli.js");
      return await runRegistryCommand(command!, rest, io, env, data);
    }
    if (command === "install" && rest.length === 1 && rest[0]) {
      const directory =
        env.OPENPLANS_PLUGIN_DIR || join(dataDirectory(env), "plugins");
      const config = loadConfig(env);
      const base = env.OPENPLANS_CONFIG
        ? dirname(env.OPENPLANS_CONFIG)
        : process.cwd();
      io.out(
        JSON.stringify(
          await (data
            ? installDataPackage(rest[0], dataDirectory(env))
            : installPlugin(rest[0], resolve(directory), {
                lockfile: pluginLockPath(config, base),
                approvedList: config.plugins.approvedList
                  ? resolve(base, config.plugins.approvedList)
                  : undefined,
                env,
              })),
        ),
      );
      return 0;
    }
    throw new Error(
      "Usage: worker plugin pack <dir> --out <dir> | install [--data] <dir|file.tgz|name@version --registry URL [--pin-sha256 HEX]> | search <q> [--registry URL] | list [--json] | update <name> [--to VERSION] [--registry URL] | remove <name> | bundle <name>@<version> --out DIR [--registry URL] | verify --local <dir|file.tgz>",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const stale =
      error instanceof Error &&
      (error.name === "ExpiredMetadataError" ||
        /expired|timestamp_expired/.test(message));
    let reason = "Package checks failed or arguments are invalid";
    if (stale)
      reason =
        "Catalog expired; install and update are blocked. Refresh the signed catalog.";
    else if (
      /^registry_[a-z_]+$|^plugin_remove_[a-z_]+$|^registry_package_(deleted:(secrets|rights|abuse)|yanked:exact_digest_pin_required)$/.test(
        message,
      )
    )
      reason = message;
    // Input parsing errors can include supplied values. Keep command output free of payloads.
    io.error(JSON.stringify({ code: "plugin_package_refused", reason }));
    return 1;
  }
}
