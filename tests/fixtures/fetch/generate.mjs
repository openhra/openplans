/** Synthetic security fixtures, no health-plan data. Regenerate: node tests/fixtures/fetch/generate.mjs */
import { deflateRawSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function syntheticZip(entries, { zip64 = false, stored = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const {
    name,
    body = "synthetic fixture\n",
    symlink = false,
  } of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(body);
    const compressed = stored ? bytes : deflateRawSync(bytes);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE(((symlink ? 0xa1ff : 0x81a4) * 65536) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  const extensions = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    extensions.push(record, locator);
  }
  return Buffer.concat([...locals, directory, ...extensions, end]);
}
export const fixtures = {
  valid: () =>
    syntheticZip([
      { name: "synthetic/data.csv", body: "synthetic\nfixture\n" },
    ]),
  bomb: () =>
    syntheticZip([
      { name: "synthetic-bomb.txt", body: "A".repeat(1024 * 1024) },
    ]),
  traversal: () => syntheticZip([{ name: ["..", "evil"].join("/") }]),
};
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Hex text keeps generated fixture artifacts reviewable and avoids committing binaries.
  for (const [name, generate] of Object.entries(fixtures)) {
    await writeFile(
      new URL(`./${name}.zip.hex`, import.meta.url),
      `${generate().toString("hex")}\n`,
    );
  }
}
