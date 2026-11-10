/** A PBP SAS input program: column order, declared types and labels. */
export interface SasLayout {
  /** `input` order, lower case, duplicates kept. */
  columns: string[];
  types: Record<string, { kind: "char" | "num"; length: number }>;
  labels: Record<string, string>;
}

function block(text: string, keyword: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${keyword}\\b([\\s\\S]*?);`, "i").exec(
    text,
  );
  if (!match) throw new Error(`SAS layout has no ${keyword} block`);
  return match[1]!;
}

export function parseSasLayout(text: string): SasLayout {
  // Informat modifiers (`name : ?? comma8.`) are not columns.
  const columns = block(text, "input")
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase().replace(/:$/, ""))
    .filter(
      (token) => token && token !== "??" && !/^[a-z]*\d*\.\d*$/.test(token),
    );
  if (
    !columns.length ||
    columns.some((name) => !/^[a-z_][a-z0-9_]*$/.test(name))
  )
    throw new Error("SAS input block has an unreadable column name");
  const types: SasLayout["types"] = {};
  for (const line of block(text, "length").split("\n")) {
    const match = /^\s*([a-z_][a-z0-9_]*)\s+(\$)?\s*(\d+)\s*$/i.exec(line);
    if (match)
      types[match[1]!.toLowerCase()] = {
        kind: match[2] ? "char" : "num",
        length: Number(match[3]),
      };
  }
  const labels: Record<string, string> = {};
  const labelBlock = /(?:^|\n)\s*label\b([\s\S]*?);/i.exec(text)?.[1] ?? "";
  for (const match of labelBlock.matchAll(
    /([a-z_][a-z0-9_]*)\s*=\s*'([^']*)'/gi,
  ))
    labels[match[1]!.toLowerCase()] = match[2]!;
  // SAS declares character columns in `length`; an undeclared input column is numeric (length 8).
  for (const name of columns) types[name] ??= { kind: "num", length: 8 };
  return { columns, types, labels };
}

/**
 * Every published column must be declared in the SAS layout. Values are read by header name, so
 * order may differ (CY2026 Section A moves four timestamps) and a layout may declare columns the
 * text file omits, but a renamed or undeclared column fails.
 */
export function assertHeaderMatches(
  header: readonly string[],
  layout: SasLayout,
  table: string,
): void {
  const declared = new Set(layout.columns);
  for (const raw of header)
    if (!declared.has(raw.trim().toLowerCase()))
      throw new Error(`${table} header differs from its SAS layout`);
}

/** Numeric cells are blank or a plain decimal; anything else is a layout change. */
export function assertTypedCell(
  layout: SasLayout,
  column: string,
  value: string,
  table: string,
  rowNumber: number,
): void {
  const type = layout.types[column];
  if (!type || !value) return;
  if (type.kind === "num" && !/^-?\d+(?:\.\d+)?$/.test(value.trim()))
    throw new Error(`${table} ${column} is not numeric at line ${rowNumber}`);
  if (type.kind === "char" && value.length > type.length)
    throw new Error(
      `${table} ${column} exceeds its length at line ${rowNumber}`,
    );
}
