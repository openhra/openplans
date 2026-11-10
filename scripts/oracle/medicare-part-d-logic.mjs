/**
 * Comparison logic of the Part D check. `readActual` reads the imported tables and asks the drug
 * service for each sampled lookup; `compare` sets that beside the independent raw-file reading
 * that `medicare-part-d-reference.py` prints.
 */
import { createHash } from "node:crypto";

export const digest = (lines) =>
  createHash("sha256")
    .update([...lines].sort().join("\n"))
    .digest("hex");

const planGroup = (row) =>
  `${row.contract_id}-${row.plan_id}-${row.segment_id === null ? 0 : Number(row.segment_id)}`;
const planRows = ["contract_id", "plan_id", "segment_id", "tier", "rxcui"];
const planRowSuffix = (row) =>
  `#${JSON.stringify(row.tier)}#${row.rxcui ?? ""}`;
const tables = {
  plan: {
    from: "partd_plan",
    columns: [
      "contract_id",
      "plan_id",
      "segment_id",
      "formulary_id",
      "suppressed",
    ],
    group: planGroup,
    suffix: (row) => `#${JSON.stringify(row.suppressed)}`,
  },
  formulary: {
    from: "partd_formulary_drug",
    columns: ["formulary_id", "tier"],
    group: (row) => row.formulary_id,
    suffix: (row) => `#${JSON.stringify(row.tier)}`,
  },
  county: {
    from: "partd_county",
    columns: ["ssa_county_code"],
    group: (row) => row.ssa_county_code,
    suffix: () => "",
  },
};
for (const name of [
  "excluded_drug",
  "indication_coverage",
  "beneficiary_cost",
  "insulin_cost",
])
  tables[name] = {
    from: "partd_plan_row",
    where: ` AND table_name='${name}'`,
    columns: planRows,
    group: planGroup,
    suffix: planRowSuffix,
  };

/** Pages through one imported table by source row and returns its lines per group. */
async function tableLines(db, snapshotId, name, header, onRow) {
  const table = tables[name];
  const groups = new Map();
  let after = -1;
  for (;;) {
    const { rows } = await db.query(
      `SELECT ${table.columns.join(",")},cells,source_row FROM ${table.from}
       WHERE snapshot_id=$1${table.where ?? ""} AND source_row>$2 ORDER BY source_row LIMIT 20000`,
      [snapshotId, after],
    );
    if (!rows.length) return groups;
    for (const row of rows) {
      const line =
        header.map((column) => row.cells[column] ?? "").join("|") +
        table.suffix(row);
      const group = table.group(row);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(line);
      onRow?.(row, group);
    }
    after = Number(rows.at(-1).source_row);
  }
}

/**
 * Builds the same structure as the reference from the database. `drug(planKey, rxcui)` answers one
 * lookup the way the drug route does.
 */
export async function readActual(db, snapshotId, expected, drug) {
  const actual = {
    rows: {},
    groups: {},
    plans: {},
    sample: [],
    suppressed: {},
  };
  for (const name of Object.keys(tables)) {
    const groups = await tableLines(
      db,
      snapshotId,
      name,
      expected.headers[name] ?? [],
      name === "plan"
        ? (row, group) => {
            const plan = (actual.plans[group] ??= {
              formularies: [],
              suppressed: false,
            });
            if (!plan.formularies.includes(row.formulary_id))
              plan.formularies.push(row.formulary_id);
            plan.suppressed ||= row.suppressed;
          }
        : undefined,
    );
    actual.rows[name] = 0;
    actual.groups[name] = {};
    for (const [group, lines] of groups) {
      actual.rows[name] += lines.length;
      actual.groups[name][group] = [lines.length, digest(lines)];
    }
  }
  for (const plan of Object.values(actual.plans)) plan.formularies.sort();
  for (const item of expected.sample) {
    const body = await drug(item.plan_key, item.rxcui);
    actual.sample.push({
      plan_key: item.plan_key,
      rxcui: item.rxcui,
      status: body.status,
      formulary_id: body.formulary_id ?? null,
      packages: (body.packages ?? []).map((p) => [
        p.proxy_ndc,
        p.tier,
        p.prior_authorization,
        p.step_therapy,
        p.quantity_limit && [p.quantity_limit.amount, p.quantity_limit.days],
      ]),
      tier_cost_sharing: (body.tier_cost_sharing ?? []).map((c) => [
        c.tier,
        c.preferred_retail.amount,
      ]),
    });
  }
  for (const key of expected.suppressed_sample)
    actual.suppressed[key] = (await drug(key, "1")).reason ?? null;
  return actual;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (value) =>
  Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
  );

/** Lists every difference between the raw-file reading and what the database and service hold. */
export function compare(expected, actual) {
  const problems = [];
  for (const [table, count] of Object.entries(expected.rows))
    if (actual.rows[table] !== count) problems.push(`rows ${table}`);
  for (const [table, groups] of Object.entries(expected.groups)) {
    const got = actual.groups[table] ?? {};
    for (const group of new Set([...Object.keys(groups), ...Object.keys(got)]))
      if (!same(groups[group], got[group])) problems.push(`${table} ${group}`);
  }
  for (const key of new Set([
    ...Object.keys(expected.plans),
    ...Object.keys(actual.plans),
  ]))
    if (
      !expected.plans[key] ||
      !actual.plans[key] ||
      !same(sorted(expected.plans[key]), sorted(actual.plans[key]))
    )
      problems.push(`plan ${key}`);
  expected.sample.forEach((item, i) => {
    if (!actual.sample[i] || !same(sorted(item), sorted(actual.sample[i])))
      problems.push(`drug ${item.plan_key} ${item.rxcui}`);
  });
  for (const key of expected.suppressed_sample)
    if (actual.suppressed[key] !== "plan_suppressed_by_cms")
      problems.push(`suppressed ${key}`);
  return problems;
}

const first = (list, test) => list.find(test);
/** Planted errors. Each changes a copy of the database reading; `compare` must notice every one. */
export const mutants = {
  tier_plus_one: (a) => {
    first(a.sample, (s) => s.packages.some((p) => p[1] !== null)).packages.find(
      (p) => p[1] !== null,
    )[1] += 1;
  },
  prior_authorization_flipped: (a) => {
    const item = first(a.sample, (s) => s.packages.length);
    item.packages[0][2] = !item.packages[0][2];
  },
  not_listed_read_as_listed: (a) => {
    first(a.sample, (s) => s.status === "not_listed").status = "listed";
  },
  cost_amount_changed: (a) => {
    const item = first(a.sample, (s) => s.tier_cost_sharing.length);
    item.tier_cost_sharing[0][1] = `${item.tier_cost_sharing[0][1] ?? ""}1`;
  },
  suppression_flag_flipped: (a) => {
    const plan = Object.values(a.plans)[0];
    plan.suppressed = !plan.suppressed;
  },
  county_dropped: (a) => {
    delete a.groups.county[Object.keys(a.groups.county)[0]];
  },
  formulary_moved_to_another_plan: (a) => {
    Object.values(a.plans)[0].formularies = ["00000000"];
  },
};

/** Runs every planted error and reports which ones the comparison caught. */
export function negativeControls(expected, actual) {
  return Object.fromEntries(
    Object.entries(mutants).map(([name, plant]) => {
      const copy = structuredClone(actual);
      plant(copy);
      return [name, compare(expected, copy).length > 0];
    }),
  );
}
