import net from "node:net";
import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "../no-network.setup.js";

// tests/no-network.setup.ts fails the running test on any non-loopback connection. The tests here
// provoke refusals on purpose and clear them. scripts/check-no-network-guard.mjs plants a test that
// fetches a public host and requires the suite to fail.
function takeRefusals(): string[] {
  const list = (globalThis as { __networkRefusals?: string[] })
    .__networkRefusals!;
  return list.splice(0);
}

describe("network guard", () => {
  it("classifies loopback hosts", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      undefined,
    ])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of [
      "example.com",
      "8.8.8.8",
      "10.0.0.5",
      "127.0.0.1.example.com",
    ])
      expect(isLoopbackHost(host)).toBe(false);
  });

  it("refuses fetch to a public host, naming test and host", async () => {
    await expect(fetch("https://example.invalid/")).rejects.toThrow(
      /example\.invalid/,
    );
    const [refusal] = takeRefusals();
    expect(refusal).toContain(
      "refuses fetch to a public host, naming test and host",
    );
    expect(refusal).toContain("example.invalid");
  });

  it("refuses a socket to a public host", async () => {
    const error = await new Promise<Error>((resolve) => {
      net.connect({ host: "192.0.2.1", port: 9 }).on("error", resolve);
    });
    expect(error.message).toMatch(/192\.0\.2\.1:9/);
    expect(takeRefusals()).toHaveLength(1);
  });
});

// Negative control: a planted test that fetches a public host must fail a vitest run that uses
// the guard, and the failure must name the test and the host. A guard that lets it pass is dead.
describe("network guard negative control", () => {
  it("fails a planted test that fetches a public host", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtemp, writeFile, symlink, rm } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../..");
    const scratch = await mkdtemp(join(tmpdir(), "openplans-nonet-"));
    try {
      await symlink(join(root, "node_modules"), join(scratch, "node_modules"));
      await writeFile(
        join(scratch, "vitest.config.mjs"),
        `export default { test: { root: ${JSON.stringify(scratch)}, setupFiles: [${JSON.stringify(join(root, "tests/no-network.setup.ts"))}], include: ["planted.test.mjs"] } };\n`,
      );
      await writeFile(
        join(scratch, "planted.test.mjs"),
        `import { it } from "vitest";
it("planted public fetch", async () => {
  // The code under test swallows the error, as many fetchers do; the guard still fails the test.
  await fetch("https://public-host.invalid/").catch(() => undefined);
});
`,
      );
      let output = "";
      let failed = false;
      try {
        execFileSync(
          process.execPath,
          [
            join(root, "node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            join(scratch, "vitest.config.mjs"),
          ],
          { cwd: scratch, encoding: "utf8", stdio: "pipe" },
        );
      } catch (error) {
        failed = true;
        const e = error as { stdout?: string; stderr?: string };
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      expect(failed).toBe(true);
      expect(output).toContain("planted public fetch");
      expect(output).toContain("public-host.invalid");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
