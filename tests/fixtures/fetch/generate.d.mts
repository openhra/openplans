export interface SyntheticEntry { name: string; body?: string; symlink?: boolean }
export function syntheticZip(entries: SyntheticEntry[], options?: { zip64?: boolean }): Buffer;
export const fixtures: Record<'valid' | 'bomb' | 'traversal', () => Buffer>;
