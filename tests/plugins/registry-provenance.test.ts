import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  installRegistryPlugin,
  searchRegistry,
} from "../../src/plugins/registry/client.js";
import {
  verifyProvenance,
  BUILD_TYPE,
} from "../../src/plugins/registry/provenance.js";
import {
  readPluginLock,
  lockPlugins,
  verifyPluginLock,
} from "../../src/plugins/lock.js";
import { loadConfig } from "../../src/config/index.js";
import { SyntheticRegistry } from "./registry-fixture.js";

const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "registry-provenance-synthetic-"));
  scratch.push(base);
  const repository = await new SyntheticRegistry(base).initialize();
  const dataDir = join(base, "data");
  await repository.trust(dataDir);
  const sha256 = createHash("sha256").update(repository.body).digest("hex");
  const identity = {
    issuer: "https://token.actions.githubusercontent.com",
    repository: "synthetic/plugins",
    repositoryId: "456",
    ref: "refs/tags/v1.0.0",
    workflowRef:
      "synthetic/plugins/.github/workflows/publish.yml@refs/tags/v1.0.0",
    runnerEnvironment: "github-hosted",
    sha: "1".repeat(40),
    runId: "100",
    runAttempt: "1",
  };
  const provenance = {
    identity,
    statement: {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: `${repository.name}@1.0.0`, digest: { sha256 } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          buildType: BUILD_TYPE,
          externalParameters: {
            repository: identity.repository,
            ref: identity.ref,
            workflow: identity.workflowRef,
          },
          resolvedDependencies: [
            {
              uri: `git+https://github.com/${identity.repository}`,
              digest: { gitCommit: identity.sha },
            },
          ],
        },
        runDetails: {
          builder: { id: `https://github.com/${identity.workflowRef}` },
          metadata: {
            invocationId:
              "https://github.com/synthetic/plugins/actions/runs/100/attempts/1",
          },
        },
      },
    },
  };
  await repository.publish({ version: 2, provenance });
  return {
    repository,
    base,
    dataDir,
    provenance,
    options: { url: repository.url, dataDir },
  };
}

it("verifies authenticated provenance before install and retains it through lock, verify and worker plugin list", async () => {
  const { repository, base, dataDir, provenance, options } = await fixture();
  const [entry] = await searchRegistry("synthetic", options);
  expect(entry!.provenance).toEqual(provenance);
  const installed = await installRegistryPlugin(
    `${repository.name}@1.0.0`,
    join(base, "plugins"),
    options,
  );
  const lock = await readPluginLock(installed.lockfile);
  expect(lock.packages[0]!.provenance!.identity).toEqual(provenance.identity);
  expect(installed.approval).toBe("not_granted");
  const input = {
    version: 1,
    plugins: {
      entries: [{ package: installed.package }],
      lockfile: installed.lockfile,
    },
  };
  const config = loadConfig({}, input);
  expect((await lockPlugins(config, base, {})).packages[0]!.provenance).toEqual(
    installed.provenance,
  );
  expect(
    (await verifyPluginLock(config, base, {})).packages[0]!.provenance,
  ).toEqual(installed.provenance);
  const configFile = join(base, "config.json");
  await writeFile(configFile, JSON.stringify(input));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../dist/worker/cli.js", import.meta.url)),
      "plugin",
      "list",
      "--json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENPLANS_CONFIG: configFile,
        OPENPLANS_DATA_DIR: dataDir,
        OPENPLANS_PLUGINS: "@synthetic/must-never-import",
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout) as unknown).toMatchObject({
    packages: [{ provenance: installed.provenance, integrity: "verified" }],
  });
  const human = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../dist/worker/cli.js", import.meta.url)),
      "plugin",
      "list",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENPLANS_CONFIG: configFile,
        OPENPLANS_DATA_DIR: dataDir,
        OPENPLANS_PLUGINS: "@synthetic/must-never-import",
      },
    },
  );
  expect(human.status, human.stderr).toBe(0);
  expect(human.stdout).toContain(
    `provenance: ${provenance.identity.repository}@${provenance.identity.sha}`,
  );
  expect(human.stdout).toContain(provenance.identity.workflowRef);
  expect(human.stdout).not.toContain(" drift");
});

it.each(["subject", "builder", "workflow", "source", "invocation"])(
  "refuses signed catalog provenance with a mismatched %s before installation",
  async (kind) => {
    const { repository, base, provenance, options } = await fixture();
    const bad = structuredClone(provenance);
    if (kind === "subject")
      bad.statement.subject[0]!.digest.sha256 = "0".repeat(64);
    if (kind === "builder")
      bad.statement.predicate.runDetails.builder.id += "-other";
    if (kind === "workflow")
      bad.statement.predicate.buildDefinition.externalParameters.workflow +=
        "-other";
    if (kind === "source")
      bad.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
        "2".repeat(40);
    if (kind === "invocation")
      bad.statement.predicate.runDetails.metadata.invocationId += "0";
    await repository.publish({ version: 3, provenance: bad });
    await expect(
      installRegistryPlugin(
        `${repository.name}@1.0.0`,
        join(base, "plugins"),
        options,
      ),
    ).rejects.toThrow(`provenance_${kind}`);
    await expect(lstat(join(base, "plugins"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("refuses altered provenance when reading an installed lock", async () => {
  const { repository, base, options } = await fixture();
  const installed = await installRegistryPlugin(
    `${repository.name}@1.0.0`,
    join(base, "plugins"),
    options,
  );
  const lock = await readPluginLock(installed.lockfile);
  lock.packages[0]!.provenance!.statement.subject[0]!.digest.sha256 =
    "0".repeat(64);
  await writeFile(installed.lockfile, JSON.stringify(lock));
  await expect(readPluginLock(installed.lockfile)).rejects.toThrow(
    /Invalid registry provenance/,
  );
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: {
        entries: [{ package: installed.package }],
        lockfile: installed.lockfile,
      },
    },
  );
  await expect(lockPlugins(config, base, {})).rejects.toThrow(
    /Invalid registry provenance/,
  );
  expect(() =>
    verifyProvenance(
      {},
      { name: repository.name, version: "1.0.0", sha256: "0".repeat(64) },
    ),
  ).toThrow();
});
