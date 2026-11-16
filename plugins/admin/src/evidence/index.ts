import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  AdminPageDependencies,
  AdminPageRegistrar,
} from "../contracts.js";
import { escapeHtml } from "../html.js";
import { navigation } from "../render.js";
import { withSessionControls } from "../session.js";
import { ADMIN_STYLES } from "../styles.js";

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RECEIPTS = 32;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const reasonCode = z.enum([
  "completed",
  "validation_failed",
  "approval_missing",
  "source_unavailable",
  "restore_not_verified",
  "operator_cancelled",
  "unknown",
]);
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    producerVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .max(32),
    kind: z.enum(["release", "audit", "backup", "restore"]),
    completedAt: z.iso.datetime(),
    outcome: z.enum(["success", "failure", "partial"]),
    deploymentId: z.string().regex(SAFE_ID),
    image: z.string().regex(SAFE_ID),
    application: z.string().regex(HASH),
    data: z.string().regex(HASH),
    inputHash: z.string().regex(HASH),
    reason: reasonCode,
  })
  .strict();

type ReceiptKind = "release" | "audit" | "backup" | "restore";
type ReceiptResult =
  | { readonly state: "missing" }
  | { readonly state: "stale"; readonly completedAt: string }
  | { readonly state: "malformed" }
  | { readonly state: "wrong_deployment" }
  | {
      readonly state: "available";
      readonly receipt: z.infer<typeof receiptSchema>;
    };

const receiptFiles: readonly {
  kind: ReceiptKind;
  file: string;
  label: string;
}[] = [
  { kind: "release", file: "release-v1.json", label: "Release" },
  { kind: "audit", file: "audit-v1.json", label: "Audit" },
  { kind: "backup", file: "backup-v1.json", label: "Backup" },
  { kind: "restore", file: "restore-v1.json", label: "Restore drill" },
];

async function readReceipt(
  directory: string,
  deploymentId: string,
  kind: ReceiptKind,
  file: string,
  now: Date,
): Promise<ReceiptResult> {
  try {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink())
      return { state: "malformed" };
    const path = join(directory, file);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: "malformed" };
    if (stat.size > MAX_RECEIPT_BYTES) return { state: "malformed" };
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_RECEIPT_BYTES)
        return { state: "malformed" };
      const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_RECEIPT_BYTES) return { state: "malformed" };
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { state: "malformed" };
    }
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== kind)
      return { state: "malformed" };
    if (parsed.data.deploymentId !== deploymentId)
      return { state: "wrong_deployment" };
    const completed = Date.parse(parsed.data.completedAt);
    if (
      !Number.isFinite(completed) ||
      completed > now.getTime() ||
      now.getTime() - completed > MAX_AGE_MS
    )
      return { state: "stale", completedAt: parsed.data.completedAt };
    return { state: "available", receipt: parsed.data };
  } catch (error) {
    if (isMissing(error)) return { state: "missing" };
    return { state: "malformed" };
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function statusText(result: ReceiptResult): string {
  switch (result.state) {
    case "missing":
      return "No receipt is present.";
    case "stale":
      return `Stale receipt completed ${escapeHtml(result.completedAt)}.`;
    case "malformed":
      return "Receipt is malformed or outside the allowed bounds.";
    case "wrong_deployment":
      return "Receipt belongs to a different deployment.";
    case "available": {
      const receipt = result.receipt;
      let outcome = "Partial result";
      if (receipt.outcome === "success") outcome = "Completed successfully";
      if (receipt.outcome === "failure") outcome = "Failed";
      return `${outcome}. Image ${escapeHtml(receipt.image)}; application ${escapeHtml(receipt.application)}; data ${escapeHtml(receipt.data)}. Reason: ${receipt.reason}. Completed ${escapeHtml(receipt.completedAt)}.`;
    }
  }
}

export function renderEvidence(
  entries: readonly { label: string; result: ReceiptResult }[],
  observedAt: string,
): string {
  const rows = entries
    .map(
      ({ label, result }) =>
        `<section><h2>${escapeHtml(label)}</h2><p class="${result.state === "available" ? "" : "unknown"}">${statusText(result)}</p></section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Releases and recovery</title><style>${ADMIN_STYLES}</style></head><body><a class="skip" href="#main">Skip to content</a><header><h1>Releases and recovery</h1>${navigation()}</header><main id="main">${rows}<p>These receipts report past observations. A release receipt does not establish current health. A backup receipt and a restore drill are separate observations. This page performs no deployment or recovery action.</p><p>Observed ${escapeHtml(observedAt)}. Refresh this page manually.</p></main></body></html>`;
}

export const registerEvidence: AdminPageRegistrar = (
  dependencies: AdminPageDependencies,
) => {
  dependencies.routes.add({
    method: "GET",
    path: "/admin/releases",
    exposure: "operator",
    adminSession: true,
    contentType: "text/html",
    handler: async (c) => {
      c.header("Cache-Control", "no-store");
      const now = dependencies.now();
      const entries = await Promise.all(
        receiptFiles
          .slice(0, MAX_RECEIPTS)
          .map(async ({ kind, file, label }) => ({
            label,
            result: dependencies.evidenceMount
              ? await readReceipt(
                  dependencies.evidenceMount.directory,
                  dependencies.evidenceMount.deploymentId,
                  kind,
                  file,
                  now,
                )
              : { state: "missing" as const },
          })),
      );
      return c.html(
        withSessionControls(
          renderEvidence(entries, now.toISOString()),
          c.get("pluginAdminSession"),
        ),
      );
    },
  });
};
