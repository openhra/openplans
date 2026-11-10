import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotMetadata } from "../../fetch/index.js";
import type { ImportFile, ImportKind } from "../puf/import-source.js";
import { IMPORT_KINDS, verifyImportFile } from "../puf/import-source.js";
import { validateImportHeader } from "../puf/import-parse.js";
import { readCsv } from "../csv/index.js";
import { createReadStream } from "node:fs";
import { normalizeSbeRow } from "./normalize.js";
import type { SbeLink } from "./source.js";

export const GEORGIA_ACCESS_SOURCE = "georgia-access-puf";
export const GEORGIA_ACCESS_HOST = "georgiaaccess.gov";
/** Owner-gated: read the publisher's unescaped quotes literally. Default off. */
export const GEORGIA_QUOTE_RECOVERY_ENV = "OPENPLANS_GA_QUOTE_RECOVERY";

const kinds: Record<string, ImportKind> = {
  PLAN: "plan-attributes",
  RATE: "rate",
  SA: "service-area",
  NTWRK: "network",
  BR: "business-rules",
  BENCS: "benefits-and-cost-sharing",
};
const fileName =
  /^(PLAN|RATE|SA|NTWRK|BR|BENCS|CW|MR|QUAL)-PUF_(\d{14})_(\d{4})(?:-\d+)?\.csv$/;

/** The admitted MR-PUF for one year. It lists each issuer's index URL. */
export async function cachedGeorgiaRegistry(
  dataDir: string,
  year: number,
): Promise<{ path: string; metadata: SnapshotMetadata }> {
  const directory = join(dataDir, "raw", GEORGIA_ACCESS_SOURCE);
  const found: SnapshotMetadata[] = [];
  for (const name of (await readdir(directory)).filter((n) =>
    n.endsWith(".meta.json"),
  )) {
    const metadata = JSON.parse(
      await readFile(join(directory, name), "utf8"),
    ) as SnapshotMetadata & {
      access_policy?: { hosts?: { host: string; state: string }[] };
    };
    const url = new URL(metadata.url);
    const match = fileName.exec(url.pathname.split("/").at(-1)!);
    if (
      url.protocol !== "https:" ||
      url.hostname !== GEORGIA_ACCESS_HOST ||
      url.search ||
      match?.[1] !== "MR" ||
      Number(match[3]) !== year ||
      !metadata.access_policy?.hosts?.some(
        (h) => h.host === GEORGIA_ACCESS_HOST && h.state === "allowed",
      )
    )
      continue;
    found.push(metadata);
  }
  if (new Set(found.map((m) => m.url)).size !== 1)
    throw new Error(
      `Georgia Access PY${year} needs exactly one admitted MR-PUF (found ${found.length})`,
    );
  const metadata = found.sort((a, b) =>
    b.fetched_at.localeCompare(a.fetched_at),
  )[0]!;
  return { path: join(directory, metadata.sha256, "payload"), metadata };
}

export interface GeorgiaAccessFile {
  kind: ImportKind;
  url: string;
  published: string;
  metadata: SnapshotMetadata;
}

/** Parse one cached file URL. Only exact georgiaaccess.gov upload paths qualify. */
export function georgiaAccessFile(
  metadata: SnapshotMetadata,
  year: number,
): GeorgiaAccessFile | null {
  const url = new URL(metadata.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== GEORGIA_ACCESS_HOST ||
    url.search ||
    !url.pathname.startsWith("/wp-content/uploads/")
  )
    return null;
  const match = fileName.exec(url.pathname.split("/").at(-1)!);
  if (!match || Number(match[3]) !== year) return null;
  const kind = kinds[match[1]!];
  if (!kind) return null;
  return { kind, url: url.href, published: match[2]!, metadata };
}

/**
 * Precedence: a CMS SBE bundle, when CMS lists one for the state and year, is the
 * catalog. Georgia Access's own files serve only a year with no CMS bundle.
 * For PY2026 Georgia Access's re-issued PLAN-PUF omits 164 variants that its own
 * rate, benefit and crosswalk files still carry, so it is never selected there.
 */
export function georgiaAccessSelectable(
  links: SbeLink[],
  year: number,
): boolean {
  return !links.some((link) => link.state === "GA" && link.year === year);
}

/** The admitted cached Georgia Access set for one year: exactly one URL per catalog kind. */
export async function cachedGeorgiaAccess(
  dataDir: string,
  year: number,
  options: { recoverUnescapedQuotes?: boolean } = {},
): Promise<ImportFile[]> {
  const directory = join(dataDir, "raw", GEORGIA_ACCESS_SOURCE);
  const found = new Map<ImportKind, GeorgiaAccessFile[]>();
  for (const name of (await readdir(directory)).filter((n) =>
    n.endsWith(".meta.json"),
  )) {
    const metadata = JSON.parse(
      await readFile(join(directory, name), "utf8"),
    ) as SnapshotMetadata & {
      access_policy?: { hosts?: { host: string; state: string }[] };
    };
    const file = georgiaAccessFile(metadata, year);
    if (!file) continue;
    // Count only bytes with an admission receipt that marks the host allowed.
    if (
      !metadata.access_policy?.hosts?.some(
        (h) => h.host === GEORGIA_ACCESS_HOST && h.state === "allowed",
      )
    )
      continue;
    found.set(file.kind, [...(found.get(file.kind) ?? []), file]);
  }
  const files: ImportFile[] = [];
  for (const kind of IMPORT_KINDS) {
    const candidates = found.get(kind) ?? [];
    if (new Set(candidates.map((c) => c.url)).size !== 1)
      throw new Error(
        `Georgia Access PY${year} needs exactly one admitted ${kind} file (found ${candidates.length})`,
      );
    const file = candidates.sort((a, b) =>
      b.metadata.fetched_at.localeCompare(a.metadata.fetched_at),
    )[0]!;
    const path = join(directory, file.metadata.sha256, "payload");
    const importFile: ImportFile = {
      kind,
      path,
      format: "csv",
      source: "georgia_access_puf",
      member: file.url.split("/").at(-1)!,
      sha256: file.metadata.sha256,
      bytes: file.metadata.bytes,
      retrievedAt: file.metadata.fetched_at,
      url: file.url,
      metadata: file.metadata,
      ...(options.recoverUnescapedQuotes
        ? { recoverUnescapedQuotes: true }
        : {}),
    };
    await verifyImportFile(importFile);
    await assertGeorgiaHeader(importFile, year);
    files.push(importFile);
  }
  return files;
}

async function assertGeorgiaHeader(file: ImportFile, year: number) {
  const stream = createReadStream(file.path);
  try {
    for await (const row of readCsv(stream, { trailingEmptyField: true })) {
      validateImportHeader(
        file.kind,
        normalizeSbeRow(file.kind, row).values,
        year,
        false,
      );
      if (
        row.values.StateCode !== "GA" ||
        row.values.BusinessYear !== String(year)
      )
        throw new Error("Georgia Access file scope mismatch");
      return;
    }
    throw new Error("Georgia Access file has no data rows");
  } finally {
    stream.destroy();
  }
}

export const georgiaQuoteRecovery = () =>
  process.env[GEORGIA_QUOTE_RECOVERY_ENV] === "on";
