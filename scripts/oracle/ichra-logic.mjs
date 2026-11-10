// Compares lowest cost silver plan answers from the raw-file reading (ichra-reference.py)
// with the answers the application gives. Both sides use the same shape per premium basis:
// { status, plan_ids, monthly_cents, prices_at_age }.

export const BASES = ["gross", "ehb_portion"];

export function caseKey(item) {
  return [
    item.county,
    item.rating_area,
    item.month,
    item.age,
    item.identification_age ?? item.age,
  ].join("|");
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One line per difference; an empty list means every case agrees on both bases. */
export function compareLcsp(reference, actual) {
  const differences = [];
  const answers = new Map(actual.map((item) => [caseKey(item), item]));
  if (answers.size !== actual.length) differences.push("duplicate actual case");
  for (const expected of reference) {
    const key = caseKey(expected);
    const answer = answers.get(key);
    if (!answer) {
      differences.push(`${key}: no application answer`);
      continue;
    }
    answers.delete(key);
    for (const basis of BASES) {
      const want = expected.bases[basis];
      const got = answer.bases[basis];
      if (!got) {
        differences.push(`${key} ${basis}: missing`);
        continue;
      }
      if (want.status !== got.status)
        differences.push(
          `${key} ${basis}: status ${got.status}, raw files give ${want.status}`,
        );
      if (want.status !== "calculated") continue;
      if (!same([...want.plan_ids].sort(), [...got.plan_ids].sort()))
        differences.push(
          `${key} ${basis}: plans ${got.plan_ids.join()}, raw files give ${want.plan_ids.join()}`,
        );
      if (
        want.monthly_cents !== got.monthly_cents ||
        !same(want.prices_at_age, got.prices_at_age)
      )
        differences.push(
          `${key} ${basis}: ${got.monthly_cents} cents, raw files give ${want.monthly_cents}`,
        );
    }
  }
  for (const key of answers.keys())
    differences.push(`${key}: no raw-file answer`);
  return differences;
}
