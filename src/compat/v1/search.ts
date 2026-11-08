/** The captured medical request for 100 records returns at most 50. */
export function pageWindow(page: number, requestedSize: number, maximumSize = 1000) {
  const size = Math.min(requestedSize, maximumSize);
  return { start: (page - 1) * size, size };
}

const compareId = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;

/** Public ID is the deterministic fallback; the captured default catalog rank is opaque. */
export function orderPlans(plans: Record<string, unknown>[], sort = 'id') {
  const descending = sort.startsWith('-'), field = sort.replace(/^-/, '');
  const metals = ['catastrophic', 'expanded_bronze', 'bronze', 'silver', 'gold', 'platinum'];
  return plans.sort((a, b) => {
    let x = a[field], y = b[field];
    if (field === 'level') { x = metals.indexOf(String(x)); y = metals.indexOf(String(y)); }
    // Unknown prices stay last in either direction. Equal values have a public-ID tie breaker,
    // independent of SQL row order or the order of an ids[] request.
    if (x == null || y == null) return x == null && y == null ? compareId(a, b) : x == null ? 1 : -1;
    const result = typeof x === 'number' && typeof y === 'number' ? x - y
      : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
    return (descending ? -result : result) || compareId(a, b);
  });
}
