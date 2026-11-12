import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const LEVELS = 4;

/**
 * The application version: the `openplans` package.json found above the entry script
 * (`dist/api/server.js`, `dist/worker/cli.js`). Undefined when the process is something else.
 */
export function applicationVersion(
  entry: string | undefined = process.argv[1],
): string | undefined {
  if (!entry) return undefined;
  let directory: string;
  try {
    directory = dirname(realpathSync(entry));
  } catch {
    return undefined;
  }
  for (let level = 0; level < LEVELS; level++) {
    try {
      const pkg: unknown = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (
        pkg &&
        typeof pkg === "object" &&
        "name" in pkg &&
        pkg.name === "openplans" &&
        "version" in pkg &&
        typeof pkg.version === "string"
      )
        return pkg.version;
    } catch {
      // No package.json at this level.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}
