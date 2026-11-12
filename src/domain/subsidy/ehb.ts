/** Published EHB shares become exact decimal strings for the cents allocator. */
export function parseEhbFraction(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(\d+)(?:\.(\d+))?\s*(%)?$/.exec(String(value).trim());
  if (!match) return null;
  const digits = match[2] ?? "";
  let scale = digits.length;
  const numerator = BigInt(match[1]! + digits);
  const unit = 10n ** BigInt(scale);
  if (numerator > 100n * unit) return null;
  if (match[3] || numerator > unit) scale += 2;
  const padded = numerator.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, padded.length - scale);
  const fraction = scale ? padded.slice(-scale).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}
