/**
 * Exact rational arithmetic for drug-cost figures. Money never passes through floating point:
 * values are BigInt fractions, and rounding to cents happens only where a figure is reported.
 */

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x || 1n;
};

export function rational(n: bigint, d = 1n): Rational {
  if (d === 0n) throw new RangeError("division by zero");
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d);
  return { n: (sign * n) / g, d: (sign * d) / g };
}

export const ZERO = rational(0n);
export const ONE = rational(1n);

/** Exact decimal text such as `12.5`, `0.25` or `-3`; anything else is rejected. */
export function parseDecimal(text: string): Rational | null {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, minus, whole, fraction = ""] = match;
  const scale = 10n ** BigInt(fraction.length);
  const value = BigInt(whole! + fraction);
  return rational(minus ? -value : value, scale);
}

export const fromCents = (cents: bigint | number): Rational =>
  rational(BigInt(cents), 100n);
export const fromBasisPoints = (points: number): Rational =>
  rational(BigInt(points), 10000n);

export const add = (a: Rational, b: Rational) =>
  rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rational, b: Rational) =>
  rational(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rational, b: Rational) => rational(a.n * b.n, a.d * b.d);
export const div = (a: Rational, b: Rational) => rational(a.n * b.d, a.d * b.n);
export const cmp = (a: Rational, b: Rational) => {
  const left = a.n * b.d;
  const right = b.n * a.d;
  if (left === right) return 0;
  return left < right ? -1 : 1;
};
export const min = (...values: Rational[]) =>
  values.reduce((a, b) => (cmp(a, b) <= 0 ? a : b));
export const max = (...values: Rational[]) =>
  values.reduce((a, b) => (cmp(a, b) >= 0 ? a : b));
export const isZero = (a: Rational) => a.n === 0n;

/** Rounds dollars to whole cents, halves away from zero. */
export function roundHalfUpCents(value: Rational): bigint {
  const scaled = value.n * 100n;
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const quotient = magnitude / value.d;
  const remainder = magnitude % value.d;
  const rounded = remainder * 2n >= value.d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Decimal text of a rational with a terminating expansion, or a fraction otherwise. */
export function formatDecimal(value: Rational): string {
  let d = value.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  if (d !== 1n) return `${value.n}/${value.d}`;
  const places = Math.max(twos, fives);
  const scaled = (value.n * 10n ** BigInt(places)) / value.d;
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled)
    .toString()
    .padStart(places + 1, "0");
  const text = places
    ? `${digits.slice(0, -places)}.${digits.slice(-places)}`
    : digits;
  return negative ? `-${text}` : text;
}

/** Cents as dollar text with two decimals, e.g. 4750n gives `47.50`. */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const text = `${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}
