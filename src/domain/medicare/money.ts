/** Published Medicare money cell: a value in cents, not applicable, or unknown (blank or unreadable). */
export type MoneyCell =
  | { status: "value"; cents: number }
  | { status: "not_applicable" }
  | { status: "unknown" };

/**
 * Parses Landscape and PBP money cells such as `$1,234.00 `, `($3.00)` (negative), `0`,
 * `Not Applicable`. Exact decimal arithmetic on the digits; never floating point.
 */
export function parseMoney(value: string | undefined): MoneyCell {
  const text = (value ?? "").trim();
  if (!text) return { status: "unknown" };
  if (/^not applicable$/i.test(text)) return { status: "not_applicable" };
  const match =
    /^(\()?(-)?\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?(\))?$/.exec(
      text,
    );
  if (!match) return { status: "unknown" };
  const [, open, minus, whole, fraction, close] = match;
  if (Boolean(open) !== Boolean(close)) return { status: "unknown" };
  if (open && minus) return { status: "unknown" };
  const cents =
    Number(whole!.replace(/,/g, "")) * 100 +
    Number((fraction ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { status: "unknown" };
  return { status: "value", cents: open || minus ? -cents : cents };
}
