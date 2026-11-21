import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { PACKAGE_LIMITS } from "@openplans/plugin-sdk/dist/package-manifest.js";
import type { PackageFile } from "@openplans/plugin-sdk/dist/package-manifest.js";
import { safePath } from "./files.js";

const BLOCK = 512;
const MAX_TAR_BYTES =
  PACKAGE_LIMITS.codeExpandedBytes + PACKAGE_LIMITS.files * BLOCK * 2 + 10240;

function bounded(max: number, label: string): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > max ? new Error(`${label} size cap exceeded`) : null, chunk);
    },
  });
}

class TarReader {
  private buffered = Buffer.alloc(0);
  private ended = false;
  constructor(private readonly source: AsyncIterator<Buffer>) {}
  async take(bytes: number): Promise<Buffer> {
    while (this.buffered.length < bytes && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else this.buffered = Buffer.concat([this.buffered, next.value]);
    }
    if (this.buffered.length < bytes)
      throw new Error("Truncated package archive");
    const result = this.buffered.subarray(0, bytes);
    this.buffered = this.buffered.subarray(bytes);
    return result;
  }
  async end(): Promise<void> {
    if (this.buffered.some((byte) => byte !== 0))
      throw new Error("Trailing package archive data");
    let trailing = this.buffered.length;
    while (!this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else {
        trailing += next.value.length;
        if (trailing > 10240 || next.value.some((byte) => byte !== 0))
          throw new Error("Trailing package archive data");
      }
    }
  }
}
function textField(header: Buffer, start: number, bytes: number): string {
  const field = header.subarray(start, start + bytes);
  const zero = field.indexOf(0);
  const content = zero < 0 ? field : field.subarray(0, zero);
  if (
    content.some((byte) => byte < 32 || byte > 126) ||
    (zero >= 0 && field.subarray(zero).some((byte) => byte !== 0))
  )
    throw new Error("Invalid tar text field");
  return content.toString("ascii");
}
function numberField(header: Buffer, start: number, bytes: number): number {
  const text = header.subarray(start, start + bytes).toString("ascii");
  if (!/^[0-7]+[\0 ]*$/.test(text)) throw new Error("Invalid tar number");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid tar size");
  return value;
}

/** Only USTAR regular files and directories are accepted. No extension can rewrite a path. */
export async function unpackArchive(
  archive: string,
  destination: string,
): Promise<void> {
  if ((await stat(archive)).size > PACKAGE_LIMITS.codeCompressedBytes)
    throw new Error("Compressed package size cap exceeded");
  await pipeline(
    createReadStream(archive),
    bounded(PACKAGE_LIMITS.codeCompressedBytes, "Compressed package"),
    createGunzip(),
    bounded(MAX_TAR_BYTES, "Expanded archive"),
    async (source: AsyncIterable<Buffer>) => {
      const reader = new TarReader(source[Symbol.asyncIterator]());
      const seen = new Set<string>();
      const aliases = new Map<string, string>();
      let entries = 0;
      let files = 0;
      let expanded = 0;
      while (true) {
        const header = await reader.take(BLOCK);
        if (header.every((byte) => byte === 0)) {
          if ((await reader.take(BLOCK)).some((byte) => byte !== 0))
            throw new Error("Invalid tar end marker");
          await reader.end();
          return;
        }
        const expected = numberField(header, 148, 8);
        let actual = 0;
        for (let index = 0; index < BLOCK; index++)
          actual += index >= 148 && index < 156 ? 32 : header[index]!;
        if (
          actual !== expected ||
          textField(header, 257, 6) !== "ustar" ||
          textField(header, 263, 2) !== "00"
        )
          throw new Error("Invalid USTAR header");
        const name = textField(header, 0, 100);
        const prefix = textField(header, 345, 155);
        const member = prefix ? `${prefix}/${name}` : name;
        const type = header[156];
        const directory = type === 53;
        if (
          (type !== 0 && type !== 48 && !directory) ||
          textField(header, 157, 100)
        )
          throw new Error("Archive links and special files are refused");
        const size = numberField(header, 124, 12);
        if (++entries > PACKAGE_LIMITS.files * 2 + 1)
          throw new Error("Package entry count cap exceeded");
        if (!member.startsWith("package/"))
          throw new Error("Unsafe archive path");
        const path = member.slice(8).replace(directory ? /\/$/ : /$^/, "");
        if (path === "" && directory && size === 0) continue;
        safePath(path);
        const parts = path.split("/");
        for (let depth = 1; depth <= parts.length; depth++) {
          const prefix = parts.slice(0, depth).join("/");
          const key = prefix.toLowerCase();
          if (aliases.has(key) && aliases.get(key) !== prefix)
            throw new Error("Case-colliding archive path");
          aliases.set(key, prefix);
        }
        if (seen.has(path.toLowerCase()))
          throw new Error("Duplicate archive path");
        seen.add(path.toLowerCase());
        if (directory) {
          if (size !== 0)
            throw new Error("Directory archive size must be zero");
          await mkdir(join(destination, path), {
            recursive: true,
            mode: 0o755,
          });
          continue;
        }
        expanded += size;
        if (
          ++files > PACKAGE_LIMITS.files ||
          expanded > PACKAGE_LIMITS.codeExpandedBytes
        )
          throw new Error("Package file count or expanded size cap exceeded");
        const full = join(destination, path);
        await mkdir(dirname(full), { recursive: true, mode: 0o755 });
        const handle = await open(full, "wx", 0o644);
        try {
          let remaining = size;
          while (remaining > 0) {
            const chunk = await reader.take(Math.min(remaining, 64 * 1024));
            let written = 0;
            while (written < chunk.length)
              written += (await handle.write(chunk, written)).bytesWritten;
            remaining -= chunk.length;
          }
        } finally {
          await handle.close();
        }
        const padding = (BLOCK - (size % BLOCK)) % BLOCK;
        if ((await reader.take(padding)).some((byte) => byte !== 0))
          throw new Error("Nonzero tar padding");
      }
    },
  );
}

function putText(
  header: Buffer,
  start: number,
  bytes: number,
  text: string,
): void {
  if (Buffer.byteLength(text) > bytes) throw new Error("Tar path too long");
  header.write(text, start, bytes, "ascii");
}
function putNumber(
  header: Buffer,
  start: number,
  bytes: number,
  value: number,
): void {
  putText(
    header,
    start,
    bytes,
    value.toString(8).padStart(bytes - 1, "0") + "\0",
  );
}
function tarHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  let name = `package/${safePath(path)}`;
  if (name.length > 100) {
    const split = name.lastIndexOf("/", 155);
    const prefix = name.slice(0, split);
    name = name.slice(split + 1);
    putText(header, 345, 155, prefix);
  }
  putText(header, 0, 100, name);
  putNumber(header, 100, 8, 0o644);
  putNumber(header, 108, 8, 0);
  putNumber(header, 116, 8, 0);
  putNumber(header, 124, 12, size);
  putNumber(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  putText(header, 257, 6, "ustar\0");
  putText(header, 263, 2, "00");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  putText(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
  return header;
}

export async function writeArchive(
  root: string,
  files: readonly PackageFile[],
  output: string,
): Promise<void> {
  async function* tar() {
    for (const file of files) {
      yield tarHeader(file.path, file.bytes);
      let bytes = 0;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(root, file.path))) {
        const data = chunk as Buffer;
        bytes += data.length;
        hash.update(data);
        if (bytes > file.bytes)
          throw new Error("Package changed while packing");
        yield data;
      }
      if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
        throw new Error("Package changed while packing");
      yield Buffer.alloc((BLOCK - (file.bytes % BLOCK)) % BLOCK);
    }
    yield Buffer.alloc(BLOCK * 2);
  }
  await pipeline(
    Readable.from(tar()),
    createGzip({ level: 9 }),
    bounded(PACKAGE_LIMITS.codeCompressedBytes, "Compressed package"),
    createWriteStream(output, { flags: "wx", mode: 0o644 }),
  );
}
