import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { PluginRouteVariables, RouteSpec } from "@openplans/plugin-sdk";
import { registerEvidence, renderEvidence } from "../../src/evidence/index.js";

const now = new Date("2026-11-15T12:00:00.000Z");
const receipt = {
  schemaVersion: 1,
  producerVersion: "1.2.3",
  kind: "release",
  completedAt: "2026-11-14T12:00:00.000Z",
  outcome: "success",
  deploymentId: "deployment-test",
  image: "image-abc123",
  application: `sha256:${"a".repeat(64)}`,
  data: `sha256:${"b".repeat(64)}`,
  inputHash: `sha256:${"c".repeat(64)}`,
  reason: "completed",
};
const directories: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "admin-evidence-"));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function page(
  directory?: string,
  deploymentId = "deployment-test",
  requestUrl = "/admin/releases",
) {
  const routes: RouteSpec[] = [];
  registerEvidence({
    routes: { add: (route) => routes.push(route) },
    status: {},
    now: () => now,
    evidenceMount: directory ? { directory, deploymentId } : undefined,
  });
  expect(routes).toMatchObject([
    {
      method: "GET",
      path: "/admin/releases",
      exposure: "operator",
      adminSession: true,
    },
  ]);
  const app = new Hono<{ Variables: PluginRouteVariables }>();
  app.get(routes[0]!.path, routes[0]!.handler);
  const result = await app.request(requestUrl);
  return { result, html: await result.text() };
}

describe("release and recovery evidence", () => {
  it("reads the four fixed receipts and separates success, backup and restore observations", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "release-v1.json"), JSON.stringify(receipt));
    await writeFile(
      join(dir, "backup-v1.json"),
      JSON.stringify({ ...receipt, kind: "backup" }),
    );
    await writeFile(
      join(dir, "restore-v1.json"),
      JSON.stringify({ ...receipt, kind: "restore" }),
    );
    const { result, html } = await page(dir);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Completed successfully");
    expect(html).toContain("Backup");
    expect(html).toContain("Restore drill");
    expect(html).toContain(
      "A backup receipt and a restore drill are separate observations",
    );
    expect(html).toContain("no deployment or recovery action");
    expect(html).toContain("Audit");
  });

  it("distinguishes missing, stale, malformed and wrong-deployment evidence", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "release-v1.json"),
      JSON.stringify({ ...receipt, completedAt: "2026-09-01T00:00:00.000Z" }),
    );
    await writeFile(join(dir, "audit-v1.json"), "{");
    await writeFile(
      join(dir, "backup-v1.json"),
      JSON.stringify({
        ...receipt,
        kind: "backup",
        deploymentId: "other-deployment",
      }),
    );
    const { html } = await page(dir);
    expect(html).toContain("Stale receipt completed");
    expect(html).toContain("Receipt is malformed");
    expect(html).toContain("belongs to a different deployment");
    expect(html).toContain("No receipt is present");
  });

  it("fails closed on oversized, symlinked, incomplete and unsafe receipt content", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "release-v1.json"), " ".repeat(65 * 1024));
    const outside = join(dir, "outside.json");
    await writeFile(outside, JSON.stringify(receipt));
    await symlink(outside, join(dir, "audit-v1.json"));
    await writeFile(
      join(dir, "backup-v1.json"),
      JSON.stringify({ schemaVersion: 1, kind: "backup", outcome: "success" }),
    );
    await writeFile(
      join(dir, "restore-v1.json"),
      JSON.stringify({
        ...receipt,
        kind: "restore",
        image: "<img src=x onerror=alert(1)>",
      }),
    );
    const { html } = await page(dir);
    expect(html.match(/Receipt is malformed/g)).toHaveLength(4);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");

    // Negative control: an event-only success claim has no completion or identity evidence.
    const eventOnly = join(dir, "audit-v1.json");
    await rm(eventOnly);
    await writeFile(
      eventOnly,
      JSON.stringify({ event: "release_completed", outcome: "success" }),
    );
    const negative = await page(dir);
    expect(negative.html).toContain("Receipt is malformed");
    expect(negative.html).not.toContain("Completed successfully");
  });

  it("never accepts request-selected file paths and reports absent mount as missing", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "outside.json"),
      JSON.stringify({ ...receipt, image: "traversal-marker" }),
    );
    const { html } = await page(
      dir,
      "deployment-test",
      "/admin/releases?file=../outside.json",
    );
    expect(html.match(/No receipt is present/g)).toHaveLength(4);
    expect(html).not.toContain("traversal-marker");
    expect(
      renderEvidence(
        [{ label: "<script>", result: { state: "missing" } }],
        "<time>",
      ),
    ).toContain("&lt;script&gt;");
    expect(html).not.toContain("directory");
  });

  it("rejects a symlinked evidence directory", async () => {
    const parent = await tempDir();
    const real = await tempDir();
    await mkdir(real, { recursive: true });
    const link = join(parent, "mounted");
    await symlink(real, link);
    const { html } = await page(link);
    expect(html.match(/Receipt is malformed/g)).toHaveLength(4);
  });
});
