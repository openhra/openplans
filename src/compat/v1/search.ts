/** Medical search pages return at most 50 records, even when 100 are requested. */
export function pageWindow(
  page: number,
  requestedSize: number,
  maximumSize = 1000,
) {
  const size = Math.min(requestedSize, maximumSize);
  return { start: (page - 1) * size, size };
}

const compareId = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  if (String(a.id) < String(b.id)) {
    return -1;
  } else if (String(a.id) > String(b.id)) {
    return 1;
  } else {
    return 0;
  }
};

/** Public ID is the deterministic default order. */
export function orderPlans(plans: Record<string, unknown>[], sort = "id") {
  const descending = sort.startsWith("-"),
    field = sort.replace(/^-/, "");
  const metals = [
    "catastrophic",
    "expanded_bronze",
    "bronze",
    "silver",
    "gold",
    "platinum",
  ];
  return plans.sort((a, b) => {
    let x = a[field],
      y = b[field];
    if (field === "level") {
      x = metals.indexOf(String(x));
      y = metals.indexOf(String(y));
    }
    // Unknown prices stay last in either direction. Equal values have a public-ID tie breaker,
    // independent of SQL row order or the order of an ids[] request.
    if (x == null || y == null) {
      if (x == null && y == null) {
        return compareId(a, b);
      } else if (x == null) {
        return 1;
      } else {
        return -1;
      }
    }
    let result;
    if (typeof x === "number" && typeof y === "number") {
      result = x - y;
    } else if (String(x) < String(y)) {
      result = -1;
    } else if (String(x) > String(y)) {
      result = 1;
    } else {
      result = 0;
    }
    return (descending ? -result : result) || compareId(a, b);
  });
}
