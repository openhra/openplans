export interface SyntheticEntry {
  name: string;
  body?: string | Uint8Array;
  symlink?: boolean;
}
export function syntheticZip(
  entries: SyntheticEntry[],
  options?: { zip64?: boolean; stored?: boolean },
): Buffer;
export const fixtures: Record<"valid" | "bomb" | "traversal", () => Buffer>;
