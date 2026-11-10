import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { FetchError, inspectZip, streamZipMember } from "../../fetch/index.js";
import type { SnapshotMetadata } from "../../fetch/index.js";
import type { PufManifest } from "../puf/acquire.js";
import { readXlsxRows } from "../xlsx/index.js";
import { readCsv } from "../csv/index.js";

export interface RegistryInput {
  path: string;
  metadata: SnapshotMetadata;
  /** Georgia Access publishes its MR-PUF as CSV with the same three columns. */
  format?: "cms-xlsx" | "georgia-access-csv";
}
export interface RegistryIssuer {
  issuer: string;
  url: string;
  row: number;
}
export async function verifyRegistry(input: RegistryInput): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(input.path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  if (
    bytes !== input.metadata.bytes ||
    hash.digest("hex") !== input.metadata.sha256
  )
    throw new FetchError("cache_error", "Registry snapshot hash mismatch");
}
export async function cachedRegistry(
  dataDir: string,
  year: number,
): Promise<RegistryInput> {
  if (!isAbsolute(dataDir)) throw new Error("Absolute data directory required");
  const directory = join(dataDir, "raw", "cms-exchange-puf");
  const name = (await readdir(directory))
    .filter((name) => /^manifest-.*\.json$/.test(name))
    .sort()
    .at(-1);
  if (!name) throw new Error("No acquired PUF manifest");
  const manifest = JSON.parse(
    await readFile(join(directory, name), "utf8"),
  ) as PufManifest;
  if (manifest.schema_version !== 1 || manifest.dry_run)
    throw new Error("Invalid PUF manifest");
  const records = manifest.files.filter(
    (file) => file.year === year && file.kind === "machine-readable-url",
  );
  const record = records[0];
  if (
    records.length !== 1 ||
    !record ||
    record.status !== "ok" ||
    !record.snapshot_id ||
    !/^[a-f0-9]{64}$/.test(record.snapshot_id) ||
    record.sha256 !== record.snapshot_id
  )
    throw new Error("Missing registry snapshot");
  const metadata = JSON.parse(
    await readFile(join(directory, `${record.snapshot_id}.meta.json`), "utf8"),
  ) as SnapshotMetadata;
  if (
    metadata.sha256 !== record.sha256 ||
    metadata.bytes !== record.bytes ||
    metadata.url !== record.url
  )
    throw new Error("Registry manifest mismatch");
  return { path: join(directory, record.snapshot_id, "payload"), metadata };
}

/** An extracted workbook is a bounded derivative of the immutable P1a ZIP, never a new download. */
export async function registryWorkbook(
  input: RegistryInput,
  dataDir: string,
): Promise<string> {
  const limits = {
    maxUncompressedBytes: 32 * 1024 ** 2,
    maxCompressedBytes: 32 * 1024 ** 2,
    maxExpansionRatio: 200,
  };
  const members = (await inspectZip(input.path, limits)).members;
  if (members.some((member) => member.name === "xl/workbook.xml"))
    return input.path;
  const workbooks = members.filter((member) => /\.xlsx$/i.test(member.name));
  if (workbooks.length !== 1)
    throw new Error("Registry must contain exactly one workbook");
  const directory = join(dataDir, "work", "qhp-registry-workbook");
  await mkdir(directory, { recursive: true });
  const partial = join(directory, `${randomUUID()}.part`);
  const file = await open(partial, "wx");
  const hash = createHash("sha256");
  try {
    for await (const chunk of streamZipMember(
      input.path,
      workbooks[0]!.name,
      limits,
    )) {
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    await file.close();
    const sha = hash.digest("hex"),
      path = join(directory, `${sha}.xlsx`);
    try {
      await link(partial, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = createHash("sha256");
      for await (const chunk of createReadStream(path)) existing.update(chunk);
      if (existing.digest("hex") !== sha)
        throw new FetchError(
          "cache_error",
          "Cached registry workbook hash mismatch",
        );
    }
    return path;
  } finally {
    await file.close();
    await rm(partial, { force: true });
  }
}

export async function readRegistry(
  path: string,
  state: string,
): Promise<RegistryIssuer[]> {
  let headers: string[] | undefined,
    rowNumber = 0;
  const issuers: RegistryIssuer[] = [];
  for await (const row of readXlsxRows(path)) {
    rowNumber++;
    if (!headers) {
      headers = row.map((value) => value.trim());
      if (
        !["State", "Issuer ID", "URL Submitted"].every(
          (key) => headers!.filter((value) => value === key).length === 1,
        )
      ) {
        throw new Error("Unexpected MR URL PUF columns");
      }
      continue;
    }
    if (row[headers.indexOf("State")]?.trim() !== state) continue;
    const issuer = row[headers.indexOf("Issuer ID")]?.trim() ?? "";
    if (!/^\d{5}$/.test(issuer)) throw new Error("Invalid registry issuer ID");
    // Contact columns are deliberately never retained in discovery records or fixtures.
    issuers.push({
      issuer,
      url: row[headers.indexOf("URL Submitted")]?.trim() ?? "",
      row: rowNumber,
    });
  }
  return issuers;
}

/**
 * Georgia Access MR-PUF CSV: State, Issuer ID, URL Submitted and a contact column.
 * The contact column is never read into records, reports or fixtures.
 */
export async function readGeorgiaRegistry(
  path: string,
  state: string,
): Promise<RegistryIssuer[]> {
  const issuers: RegistryIssuer[] = [];
  const input = createReadStream(path);
  try {
    for await (const row of readCsv(input, { trailingEmptyField: true })) {
      if (
        !["State", "Issuer ID", "URL Submitted"].every((k) => k in row.values)
      )
        throw new Error("Unexpected MR-PUF columns");
      if (row.values.State!.trim() !== state) continue;
      const issuer = row.values["Issuer ID"]!.trim();
      if (!/^\d{5}$/.test(issuer))
        throw new Error("Invalid registry issuer ID");
      issuers.push({
        issuer,
        url: row.values["URL Submitted"]!.trim(),
        row: row.rowNumber,
      });
    }
  } finally {
    input.destroy();
  }
  return issuers;
}
