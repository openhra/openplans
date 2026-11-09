import { inflateRawSync } from "node:zlib";

// Compare single-entry security goldens without pinning zlib's deflate encoding.
// Preserve every other header byte, including deliberately dishonest size claims.
export function singleEntryZipContents(zip: Buffer): Buffer {
  const end = Buffer.from(zip.subarray(-22));
  const centralOffset = end.readUInt32LE(16);
  if (
    end.readUInt32LE(0) !== 0x06054b50 ||
    end.readUInt16LE(10) !== 1 ||
    zip.readUInt32LE(0) !== 0x04034b50 ||
    zip.readUInt32LE(centralOffset) !== 0x02014b50
  ) {
    throw new Error("Expected a single-entry fixture ZIP");
  }
  const bodyOffset = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  const header = Buffer.from(zip.subarray(0, bodyOffset));
  const central = Buffer.from(zip.subarray(centralOffset, zip.length - 22));
  const encoded = zip.subarray(bodyOffset, bodyOffset + zip.readUInt32LE(18));
  const method = header.readUInt16LE(8);
  if (method !== 0 && method !== 8)
    throw new Error("Unsupported fixture compression");
  const body = method === 8 ? inflateRawSync(encoded) : encoded;
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(body.length, 18);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(body.length, 20);
  end.writeUInt32LE(header.length + body.length, 16);
  return Buffer.concat([header, body, central, end]);
}
