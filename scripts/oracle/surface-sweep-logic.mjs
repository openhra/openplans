/**
 * The pass rule for `surface-sweep.mjs`, kept free of I/O so tests/oracle/surface-sweep.test.mjs
 * can check it on synthetic responses. A response fails when it is a 5xx, when it carries the MCP
 * code INTERNAL_HONESTY_CHECK, or when it answers with nothing and says nothing about why.
 */

/** Keys whose non-empty string values (or string arrays) say why an answer is missing. */
const REASON_KEYS = new Set([
  "issues",
  "location_issues",
  "reason",
  "reasons",
  "ichra_reason",
  "subsidy_reason",
]);

/**
 * Status values that say only that there is or is not an answer. Any other status names its own
 * reason (`ambiguous`, `unsupported_state`, `unsupported_rating_method`, ...).
 */
const GENERIC_STATUSES = new Set([
  "ok",
  "available",
  "calculated",
  "rated",
  "unknown",
  "error",
  "not_requested",
  "not_evaluated",
]);
const STATUS_KEYS = new Set(["status", "location_status", "resolution"]);

/**
 * Every reason code the response names: reason keys and error codes at any depth, and specific
 * status values on the response, its `data` or its `location`.
 */
export function reasonsIn(value, gaps = "") {
  const found = new Set(
    String(gaps)
      .split(",")
      .map((gap) => gap.trim())
      .filter(Boolean),
  );
  const add = (item) => {
    if (typeof item === "string" && item) found.add(item);
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      if (REASON_KEYS.has(key)) {
        if (Array.isArray(item)) item.forEach(add);
        else add(item);
      }
      if (key === "error") {
        if (typeof item === "string") add(item);
        else if (item && typeof item === "object") add(item.code);
      }
      walk(item);
    }
  };
  walk(value);
  for (const node of [
    value,
    value?.data,
    value?.location,
    value?.data?.location,
  ])
    if (node && typeof node === "object" && !Array.isArray(node))
      for (const key of STATUS_KEYS)
        if (typeof node[key] === "string" && !GENERIC_STATUSES.has(node[key]))
          found.add(node[key]);
  return [...found].sort();
}

/** Whether the value names INTERNAL_HONESTY_CHECK anywhere, as a code or inside a message. */
export function namesHonestyCheck(value) {
  if (typeof value === "string")
    return value.includes("INTERNAL_HONESTY_CHECK");
  if (Array.isArray(value)) return value.some(namesHonestyCheck);
  if (value && typeof value === "object")
    return Object.values(value).some(namesHonestyCheck);
  return false;
}

/**
 * The failure classes of one response. `items` is the answer's list (plans, quotes, rows) or,
 * for a single answer, an array holding the answer when it has a value and empty when it has
 * none; undefined skips the emptiness rule for surfaces that always describe something.
 */
export function checkResponse({ status, body, gaps, items }) {
  const failures = [];
  if (typeof status === "number" && status >= 500) failures.push("http_5xx");
  if (namesHonestyCheck(body)) failures.push("internal_honesty_check");
  if (
    Array.isArray(items) &&
    items.length === 0 &&
    !reasonsIn(body, gaps).length
  )
    failures.push("empty_without_reason");
  return failures;
}

/** Groups failures into classes with a count and the first few inputs of each. */
export function summarize(failures, sample = 5) {
  const classes = new Map();
  for (const failure of failures) {
    const key = `${failure.class} ${failure.surface}`;
    const entry = classes.get(key) ?? {
      class: failure.class,
      surface: failure.surface,
      count: 0,
      examples: [],
    };
    entry.count++;
    if (entry.examples.length < sample) entry.examples.push(failure);
    classes.set(key, entry);
  }
  return [...classes.values()].sort((a, b) =>
    `${a.class} ${a.surface}`.localeCompare(`${b.class} ${b.surface}`),
  );
}
