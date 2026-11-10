/**
 * A small reader for the two shapefile members county outlines need: polygon geometry (.shp) and
 * its attribute table (.dbf). It accepts only what the Census cartographic boundary files use:
 * polygon shapes (type 5) and character or numeric dBASE fields. Anything else is an error.
 */
export type Ring = [number, number][];
export interface ShapeRecord {
  /** Parts as published: outer rings and holes, each closed, in [longitude, latitude] order. */
  rings: Ring[];
}
const invalid = (what: string) => new Error(`Invalid shapefile: ${what}`);

export function readPolygons(shp: Buffer): ShapeRecord[] {
  if (shp.length < 100 || shp.readInt32BE(0) !== 9994)
    throw invalid("bad .shp header");
  if (shp.readInt32BE(24) * 2 !== shp.length)
    throw invalid(".shp length mismatch");
  if (shp.readInt32LE(28) !== 1000) throw invalid("unsupported version");
  if (shp.readInt32LE(32) !== 5) throw invalid("not a polygon file");
  const records: ShapeRecord[] = [];
  let offset = 100;
  while (offset < shp.length) {
    if (offset + 8 > shp.length) throw invalid("truncated record header");
    const number = shp.readInt32BE(offset),
      words = shp.readInt32BE(offset + 4),
      start = offset + 8,
      end = start + words * 2;
    if (number !== records.length + 1 || words < 2 || end > shp.length)
      throw invalid(`record ${records.length + 1}`);
    const type = shp.readInt32LE(start);
    if (type === 0) {
      records.push({ rings: [] });
      offset = end;
      continue;
    }
    if (type !== 5 || start + 44 > end) throw invalid(`record ${number} type`);
    const parts = shp.readInt32LE(start + 36),
      points = shp.readInt32LE(start + 40),
      partStart = start + 44,
      pointStart = partStart + parts * 4;
    if (parts < 1 || points < 4 || pointStart + points * 16 !== end)
      throw invalid(`record ${number} size`);
    const rings: Ring[] = [];
    for (let p = 0; p < parts; p++) {
      const first = shp.readInt32LE(partStart + p * 4),
        last =
          p + 1 < parts ? shp.readInt32LE(partStart + (p + 1) * 4) : points;
      if (first < 0 || last > points || last - first < 4)
        throw invalid(`record ${number} part ${p}`);
      const ring: Ring = [];
      for (let i = first; i < last; i++) {
        const x = shp.readDoubleLE(pointStart + i * 16),
          y = shp.readDoubleLE(pointStart + i * 16 + 8);
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw invalid(`record ${number} coordinate`);
        ring.push([x, y]);
      }
      const [x0, y0] = ring[0]!,
        [xn, yn] = ring[ring.length - 1]!;
      if (x0 !== xn || y0 !== yn) throw invalid(`record ${number} open ring`);
      rings.push(ring);
    }
    records.push({ rings });
    offset = end;
  }
  return records;
}

export function readDbf(dbf: Buffer): Record<string, string>[] {
  if (dbf.length < 33) throw invalid("bad .dbf header");
  const count = dbf.readUInt32LE(4),
    headerBytes = dbf.readUInt16LE(8),
    recordBytes = dbf.readUInt16LE(10);
  if (headerBytes + count * recordBytes > dbf.length || recordBytes < 1)
    throw invalid(".dbf length");
  const fields: { name: string; type: string; offset: number; size: number }[] =
    [];
  let position = 1;
  for (let at = 32; at < headerBytes - 1 && dbf[at] !== 0x0d; at += 32) {
    const name = dbf
        .subarray(at, at + 11)
        .toString("latin1")
        .replace(/\0.*$/s, ""),
      type = String.fromCharCode(dbf[at + 11]!),
      size = dbf[at + 16]!;
    if (!"CNF".includes(type)) throw invalid(`field ${name} type ${type}`);
    fields.push({ name, type, offset: position, size });
    position += size;
  }
  if (position !== recordBytes) throw invalid(".dbf record size");
  const rows: Record<string, string>[] = [];
  for (let r = 0; r < count; r++) {
    const start = headerBytes + r * recordBytes;
    if (dbf[start] === 0x2a) throw invalid(".dbf deleted record");
    const row: Record<string, string> = {};
    for (const f of fields)
      row[f.name] = dbf
        .subarray(start + f.offset, start + f.offset + f.size)
        .toString("utf8")
        .trim();
    rows.push(row);
  }
  return rows;
}
