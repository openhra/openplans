export const dataDirectory: URL;
export const generatedFile: URL;
export function readParameterFiles(
  directory?: URL,
): Promise<{ name: string; value: unknown }[]>;
export function registrySource(
  files: { name: string; value: unknown }[],
): string;
