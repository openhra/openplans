import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SERVICES = ["api", "worker", "scheduler"];
const LINES = [
  "OPENPLANS_PLUGINS: ${OPENPLANS_PLUGINS:-}",
  "OPENPLANS_CONFIG: ${OPENPLANS_CONFIG:-}",
  "- source: openplans_config",
  "target: ${OPENPLANS_CONFIG:-/run/openplans/no-config}",
];

function service(compose: string, name: string) {
  const body = compose.split(`\n  ${name}:\n`)[1];
  if (body === undefined) throw new Error(`no ${name} service`);
  return body.split(/\n(?: {2}[a-z]+:|[a-z]+:)\n/)[0]!;
}

/** Names each service missing a plugin setting, or the config file definition. */
function missing(compose: string) {
  const gaps = SERVICES.flatMap((name) =>
    LINES.filter((line) => !service(compose, name).includes(line)).map(
      (line) => `${name}: ${line}`,
    ),
  );
  if (
    !/\nconfigs:\n(?: {2}#.*\n)* {2}openplans_config:\n {4}file: \$\{OPENPLANS_CONFIG:-\/dev\/null\}\n/.test(
      compose,
    )
  )
    gaps.push("configs.openplans_config");
  return gaps;
}

describe("compose.yml plugin settings", () => {
  it("passes the plugin list and config file to api, worker and scheduler", async () => {
    const compose = await readFile(
      new URL("../compose.yml", import.meta.url),
      "utf8",
    );
    expect(missing(compose)).toEqual([]);
    const worker = service(compose, "worker");
    const mutant = compose.replace(worker, worker.replace(LINES[0]!, ""));
    expect(missing(mutant)).toEqual([`worker: ${LINES[0]}`]);
  });
});
