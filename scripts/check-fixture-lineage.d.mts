export const PUBLIC_HOSTS: string[];
export const BUILTIN_DENY: string[];
export function loadDeny(file?: string): Promise<Set<string>>;
export function checkFixtureLineage(
  root: string,
  deny?: Set<string>,
): Promise<string[]>;
