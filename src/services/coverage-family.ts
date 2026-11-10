/** Plan-attribute rows for one base plan, as exchangeAttributeRows returns them. */
export type AttributeRow = { raw: Record<string, string>; source_row: number };

/** The field's value when every row agrees on it; otherwise undefined (missing or conflicting). */
export function agreedField(
  rows: readonly AttributeRow[],
  field: string,
): string | undefined {
  const values = new Set(rows.map((r) => r.raw[field]?.trim()));
  return values.size === 1 ? [...values][0] : undefined;
}

/**
 * Whether a plan's ChildOnlyOffering admits a coverage family with adults and/or children.
 * null when the field is missing, conflicting or not a published value.
 */
export function familyOffer(
  rows: readonly AttributeRow[],
  hasAdult: boolean,
  hasChild: boolean,
): boolean | null {
  const value = agreedField(rows, "ChildOnlyOffering");
  if (
    !value ||
    ![
      "Allows Adult and Child-Only",
      "Allows Adult-Only",
      "Allows Child-Only",
    ].includes(value)
  )
    return null;
  return (
    (!hasAdult || value !== "Allows Child-Only") &&
    (!hasChild || value !== "Allows Adult-Only")
  );
}
