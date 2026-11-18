import { gzipSync, gunzipSync } from "node:zlib";

import {
  encodeEvidence,
  decodeEvidence,
  evidenceNode,
  indexEvidence,
  type EvidenceIndex,
  type EvidenceNode,
  type EvidenceDictionary,
} from "./lowest-evidence-binary.js";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Lossless subtree sharing across the ages of one county/year publication. */
export class LowestEvidence {
  readonly decodedBytes: number;
  // Reads decode only the nodes they visit; the first write decodes the rest.
  private readonly stored?: EvidenceIndex;
  private decoded?: EvidenceDictionary;
  private readonly ids = new Map<string, number>();
  private indexed = false;
  private last?: { key: string; root: number; value: Json };

  constructor(payload?: string) {
    const raw = payload
      ? gunzipSync(Buffer.from(payload, "base64"), {
          maxOutputLength: 64 * 1024 ** 2,
        })
      : undefined;
    this.decodedBytes = raw ? raw.length * 8 : 0;
    if (raw) this.stored = indexEvidence(raw);
  }

  private get dictionary(): EvidenceDictionary {
    this.decoded ??= this.stored
      ? decodeEvidence(this.stored.bytes)
      : { nodes: [], roots: {} };
    return this.decoded;
  }

  private nodeAt(id: number) {
    return this.decoded || !this.stored
      ? this.dictionary.nodes[id]
      : evidenceNode(this.stored, id);
  }

  private get roots() {
    return this.decoded || !this.stored
      ? this.dictionary.roots
      : this.stored.roots;
  }

  private index() {
    if (!this.indexed) {
      for (const [index, node] of this.dictionary.nodes.entries())
        this.ids.set(JSON.stringify(node), index);
      this.indexed = true;
    }
  }

  private node(node: EvidenceNode) {
    this.index();
    const bytes = JSON.stringify(node);
    const existing = this.ids.get(bytes);
    if (existing !== undefined) return existing;
    const id = this.dictionary.nodes.length;
    this.dictionary.nodes.push(node);
    this.ids.set(bytes, id);
    return id;
  }

  reference(value: string | null) {
    return value === null ? null : this.node([0, value]);
  }

  scalar(id: number | null) {
    if (id === null) return null;
    const node = this.nodeAt(id);
    return node?.[0] === 0 && typeof node[1] === "string" ? node[1] : undefined;
  }

  set(key: string, value: unknown) {
    const visit = (value: Json): number => {
      let node: EvidenceNode;
      if (Array.isArray(value)) node = [1, value.map(visit)];
      else if (value !== null && typeof value === "object")
        node = [
          2,
          Object.entries(value).map(([key, entry]): [number, number] => [
            visit(key),
            visit(entry),
          ]),
        ];
      else node = [0, value];
      return this.node(node);
    };
    // JSON's treatment of absent values matches the original stored publication.
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 2 * 1024 ** 2)
      throw new Error("Lowest premium cell too large");
    const root = visit(JSON.parse(body) as Json);
    this.dictionary.roots[key] = root;
    return root;
  }

  get(key: string, expectedRoot?: number): unknown {
    const root = Object.hasOwn(this.roots, key) ? this.roots[key] : undefined;
    if (
      root === undefined ||
      (expectedRoot !== undefined && root !== expectedRoot)
    )
      return undefined;
    if (this.last?.key === key && this.last.root === root)
      return this.last.value;
    const visit = (id: number, depth: number): Json => {
      if (!Number.isInteger(id) || depth > 100)
        throw new Error("Invalid county evidence reference");
      const node = this.nodeAt(id);
      if (!node) throw new Error("Missing county evidence node");
      if (node[0] === 0) return node[1];
      if (node[0] === 1) return node[1].map((child) => visit(child, depth + 1));
      if (node[0] === 2)
        return Object.fromEntries(
          node[1].map(([key, child]) => {
            const name = visit(key, depth + 1);
            if (typeof name !== "string")
              throw new Error("Invalid county evidence key");
            return [name, visit(child, depth + 1)];
          }),
        );
      throw new Error("Invalid county evidence node");
    };
    const value = visit(root, 0);
    const freeze = (value: Json): void => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(value);
    this.last = { key, root, value };
    return value;
  }

  encode() {
    const raw = encodeEvidence(this.dictionary);
    return {
      payload: gzipSync(raw).toString("base64"),
      rawBytes: raw.length,
    };
  }
}
