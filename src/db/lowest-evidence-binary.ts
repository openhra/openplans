export type EvidenceNode =
  | [0, null | boolean | number | string]
  | [1, number[]]
  | [2, [number, number][]];
export interface EvidenceDictionary {
  nodes: EvidenceNode[];
  roots: Record<string, number>;
}

const magic = Buffer.from("LCE1");
const maximumBytes = 64 * 1024 ** 2;

class Writer {
  private buffer = Buffer.alloc(65536);
  private length = 0;
  private reserve(bytes: number) {
    if (this.length + bytes > maximumBytes)
      throw new Error("County evidence too large");
    if (this.length + bytes > this.buffer.length) {
      const next = Buffer.alloc(
        Math.min(
          maximumBytes,
          Math.max(this.buffer.length * 2, this.length + bytes),
        ),
      );
      this.buffer.copy(next, 0, 0, this.length);
      this.buffer = next;
    }
  }
  byte(value: number) {
    this.reserve(1);
    this.buffer[this.length++] = value;
  }
  integer(value: number) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid evidence integer");
    while (value >= 128) {
      this.byte((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    this.byte(value);
  }
  string(value: string) {
    const bytes = Buffer.from(value);
    this.integer(bytes.length);
    this.reserve(bytes.length);
    bytes.copy(this.buffer, this.length);
    this.length += bytes.length;
  }
  double(value: number) {
    this.reserve(8);
    this.buffer.writeDoubleLE(value, this.length);
    this.length += 8;
  }
  finish() {
    return this.buffer.subarray(0, this.length);
  }
}

/** Object key order is shared once per shape; all node references use unsigned varints. */
export function encodeEvidence(dictionary: EvidenceDictionary) {
  const shapes: number[][] = [],
    byKeys = new Map<string, number>();
  const shapeIds = dictionary.nodes.map((node) => {
    if (node[0] !== 2) return -1;
    const keys = node[1].map(([key]) => key),
      bytes = JSON.stringify(keys);
    let id = byKeys.get(bytes);
    if (id === undefined) {
      id = shapes.length;
      shapes.push(keys);
      byKeys.set(bytes, id);
    }
    return id;
  });
  const writer = new Writer();
  for (const byte of magic) writer.byte(byte);
  writer.integer(shapes.length);
  for (const keys of shapes) {
    writer.integer(keys.length);
    for (const key of keys) writer.integer(key);
  }
  writer.integer(dictionary.nodes.length);
  for (const [index, node] of dictionary.nodes.entries()) {
    writer.byte(node[0]);
    if (node[0] === 0) {
      const value = node[1];
      if (value === null) writer.byte(0);
      else if (value === false) writer.byte(1);
      else if (value === true) writer.byte(2);
      else if (typeof value === "string") {
        writer.byte(6);
        writer.string(value);
      } else if (Number.isSafeInteger(value)) {
        writer.byte(value >= 0 ? 3 : 4);
        writer.integer(Math.abs(value));
      } else {
        writer.byte(5);
        writer.double(value);
      }
    } else if (node[0] === 1) {
      writer.integer(node[1].length);
      for (const child of node[1]) writer.integer(child);
    } else {
      writer.integer(shapeIds[index]!);
      for (const [, child] of node[1]) writer.integer(child);
    }
  }
  const roots = Object.entries(dictionary.roots);
  writer.integer(roots.length);
  for (const [key, value] of roots) {
    writer.string(key);
    writer.integer(value);
  }
  return writer.finish();
}

/** Byte offsets of every node, so a read decodes only the subtree it returns. */
export interface EvidenceIndex {
  bytes: Buffer;
  shapes: number[][];
  offsets: Uint32Array;
  roots: Record<string, number>;
}

function reader(bytes: Buffer, start: number) {
  let offset = start;
  const fail = (): never => {
    throw new Error("Invalid binary county evidence");
  };
  const byte = () => {
    if (offset >= bytes.length) fail();
    return bytes[offset++]!;
  };
  const integer = () => {
    let value = 0,
      multiplier = 1;
    for (let count = 0; count < 8; count++) {
      const part = byte();
      value += (part % 128) * multiplier;
      if (!Number.isSafeInteger(value)) fail();
      if (part < 128) return value;
      multiplier *= 128;
    }
    return fail();
  };
  const length = () => {
    const value = integer();
    if (value > bytes.length) fail();
    return value;
  };
  const skip = (size: number) => {
    if (offset + size > bytes.length) fail();
    offset += size;
    return offset - size;
  };
  const string = () => {
    const size = length();
    const at = skip(size);
    return bytes.toString("utf8", at, at + size);
  };
  const double = () => {
    const value = bytes.readDoubleLE(skip(8));
    if (!Number.isFinite(value)) fail();
    return value;
  };
  return {
    fail,
    byte,
    integer,
    length,
    skip,
    string,
    double,
    offset: () => offset,
  };
}

/** Validates the whole layout without building strings or node arrays. */
export function indexEvidence(bytes: Buffer): EvidenceIndex {
  const read = reader(bytes, magic.length);
  if (
    !bytes.subarray(0, magic.length).equals(magic) ||
    bytes.length > maximumBytes
  )
    read.fail();
  const shapes: number[][] = [];
  for (let count = read.length(); count > 0; count--) {
    const keys: number[] = [];
    for (let size = read.length(); size > 0; size--) keys.push(read.integer());
    shapes.push(keys);
  }
  const offsets = new Uint32Array(read.length());
  for (let index = 0; index < offsets.length; index++) {
    offsets[index] = read.offset();
    const kind = read.byte();
    if (kind === 0) {
      const scalar = read.byte();
      if (scalar === 3 || scalar === 4) read.integer();
      else if (scalar === 6) read.skip(read.length());
      else if (scalar === 5) read.double();
      else if (scalar > 2) read.fail();
    } else if (kind === 1) {
      for (let size = read.length(); size > 0; size--) read.integer();
    } else if (kind === 2) {
      const keys = shapes[read.integer()] ?? read.fail();
      for (let size = keys.length; size > 0; size--) read.integer();
    } else read.fail();
  }
  const roots: Record<string, number> = {};
  for (let count = read.length(); count > 0; count--) {
    const key = read.string();
    if (Object.hasOwn(roots, key)) read.fail();
    Object.defineProperty(roots, key, {
      value: read.integer(),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (read.offset() !== bytes.length) read.fail();
  return { bytes, shapes, offsets, roots };
}

/** Decodes one node of an indexed payload; undefined when the id is out of range. */
export function evidenceNode(
  index: EvidenceIndex,
  id: number,
): EvidenceNode | undefined {
  const start = index.offsets[id];
  if (!Number.isInteger(id) || start === undefined) return undefined;
  const read = reader(index.bytes, start);
  const kind = read.byte();
  if (kind === 0) {
    const scalar = read.byte();
    if (scalar === 0) return [0, null];
    if (scalar === 1) return [0, false];
    if (scalar === 2) return [0, true];
    if (scalar === 3 || scalar === 4)
      return [0, read.integer() * (scalar === 3 ? 1 : -1)];
    if (scalar === 6) return [0, read.string()];
    return [0, read.double()];
  }
  if (kind === 1) {
    const values: number[] = [];
    for (let size = read.length(); size > 0; size--)
      values.push(read.integer());
    return [1, values];
  }
  const keys = index.shapes[read.integer()]!;
  return [2, keys.map((key): [number, number] => [key, read.integer()])];
}

export function decodeEvidence(bytes: Buffer): EvidenceDictionary {
  const index = indexEvidence(bytes);
  return {
    nodes: Array.from(index.offsets, (_, id) => evidenceNode(index, id)!),
    roots: index.roots,
  };
}
