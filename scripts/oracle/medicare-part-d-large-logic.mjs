import { createHash } from "node:crypto";

const modulus = 1n << 256n;
const planGroup = (row) =>
  `${row.contract_id}-${row.plan_id}-${Number(row.segment_id)}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Count plus sum of row SHA-256 values, independent of row order and bounded in memory. */
export function rowAccumulator() {
  let count = 0;
  let sum = 0n;
  return {
    add(line) {
      count++;
      sum =
        (sum + BigInt(`0x${createHash("sha256").update(line).digest("hex")}`)) %
        modulus;
    },
    result: () => [count, sum.toString(16).padStart(64, "0")],
  };
}

/** Pages by indexed keys; only one page and one plan's accumulator stay in memory. */
export async function readLargeActual(
  db,
  snapshotId,
  expected,
  pharmacy,
  drug,
) {
  const actual = {
    rows: { pharmacy_network: 0, pricing: 0 },
    groups: { pharmacy_network: {}, pricing: {} },
    plans: [],
    pharmacy_sample: [],
    price_sample: [],
  };
  actual.plans = (
    await db.query(
      `SELECT DISTINCT contract_id,plan_id,segment_id FROM partd_plan
    WHERE snapshot_id=$1`,
      [snapshotId],
    )
  ).rows
    .map(planGroup)
    .sort();
  const networks = (
    await db.query(
      `SELECT contract_id,plan_id,segment_id,network_id FROM partd_plan_network
    WHERE snapshot_id=$1 ORDER BY contract_id,plan_id,segment_id`,
      [snapshotId],
    )
  ).rows;
  for (const network of networks) {
    const hash = rowAccumulator();
    let after = "";
    for (;;) {
      const { rows } = await db.query(
        `SELECT npi,zip,cells FROM partd_network_pharmacy
        WHERE snapshot_id=$1 AND network_id=$2 AND npi>$3 ORDER BY npi LIMIT 10000`,
        [snapshotId, network.network_id, after],
      );
      if (!rows.length) break;
      for (const row of rows)
        hash.add(
          [
            row.npi,
            row.zip,
            ...expected.headers.pharmacy_network
              .slice(5)
              .map((c) => row.cells[c] ?? ""),
          ].join("|"),
        );
      after = rows.at(-1).npi;
    }
    const result = hash.result();
    actual.groups.pharmacy_network[planGroup(network)] = result;
    actual.rows.pharmacy_network += result[0];
    const stored = (
      await db.query(
        `SELECT pharmacies FROM partd_network WHERE snapshot_id=$1 AND network_id=$2`,
        [snapshotId, network.network_id],
      )
    ).rows[0];
    if (Number(stored?.pharmacies) !== result[0])
      actual.groups.pharmacy_network[planGroup(network)] = [
        result[0],
        "stored-count-mismatch",
      ];
  }
  const priced = (
    await db.query(
      `SELECT DISTINCT contract_id,plan_id,segment_id FROM partd_unit_cost
    WHERE snapshot_id=$1 ORDER BY contract_id,plan_id,segment_id`,
      [snapshotId],
    )
  ).rows;
  for (const plan of priced) {
    const hash = rowAccumulator();
    let ndc = "",
      days = -1;
    for (;;) {
      const { rows } = await db.query(
        `SELECT ndc,days_supply,unit_cost::text FROM partd_unit_cost
        WHERE snapshot_id=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4
        AND (ndc,days_supply)>($5,$6) ORDER BY ndc,days_supply LIMIT 10000`,
        [
          snapshotId,
          plan.contract_id,
          plan.plan_id,
          plan.segment_id,
          ndc,
          days,
        ],
      );
      if (!rows.length) break;
      for (const row of rows)
        hash.add(`${row.ndc}|${row.days_supply}|${row.unit_cost}`);
      ndc = rows.at(-1).ndc;
      days = rows.at(-1).days_supply;
    }
    const result = hash.result();
    actual.groups.pricing[planGroup(plan)] = result;
    actual.rows.pricing += result[0];
  }
  for (const query of expected.pharmacy_sample) {
    const body = await pharmacy(query.plan_key, query.zip);
    actual.pharmacy_sample.push({
      plan_key: query.plan_key,
      zip: query.zip,
      status: body.status,
      pharmacies: (body.pharmacies ?? []).map((p) => [
        p.npi,
        p.retail,
        p.mail_order,
        p.preferred_retail,
        p.preferred_mail,
        p.in_service_area,
      ]),
    });
  }
  for (const query of expected.price_sample) {
    const body = await drug(query.plan_key, query.rxcui);
    const cost = body.average_unit_cost ?? body;
    const answer = {
      plan_key: query.plan_key,
      rxcui: query.rxcui,
      status: cost.status,
      rows: (cost.rows ?? []).map((r) => [r.ndc, r.days_supply, r.unit_cost]),
    };
    if (cost.reason) answer.reason = cost.reason;
    actual.price_sample.push(answer);
  }
  return actual;
}

export function compareLarge(expected, actual) {
  const problems = [];
  if (!same(expected.plans, actual.plans)) problems.push("selected plans");
  for (const table of ["pharmacy_network", "pricing"]) {
    if (expected.rows[table] !== actual.rows[table])
      problems.push(`rows ${table}`);
    for (const key of new Set([
      ...Object.keys(expected.groups[table]),
      ...Object.keys(actual.groups[table]),
    ]))
      if (!same(expected.groups[table][key], actual.groups[table][key]))
        problems.push(`${table} ${key}`);
  }
  for (const name of ["pharmacy_sample", "price_sample"]) {
    if (expected[name].length !== actual[name].length)
      problems.push(`length ${name}`);
    expected[name].forEach((query, i) => {
      if (!same(query, actual[name][i]))
        problems.push(`${name} ${query.plan_key} ${query.zip ?? query.rxcui}`);
    });
  }
  return problems;
}

/** Each applicable error must be rejected by the same comparison used on archive results. */
export function largeNegativeControls(expected, actual) {
  const mutations = {
    membership_dropped: (a) => {
      delete a.groups.pharmacy_network[
        Object.keys(a.groups.pharmacy_network)[0]
      ];
    },
    network_count_changed: (a) => {
      a.rows.pharmacy_network++;
    },
    pharmacy_dropped: (a) => {
      a.pharmacy_sample.find((q) => q.pharmacies.length).pharmacies.pop();
    },
    pharmacy_flag_flipped: (a) => {
      const p = a.pharmacy_sample.find((q) => q.pharmacies.length)
        .pharmacies[0];
      p[3] = !p[3];
    },
    pharmacy_zip_changed: (a) => {
      a.pharmacy_sample[0].zip = "mutant";
    },
    price_status_changed: (a) => {
      a.price_sample[0].status = "mutant";
    },
  };
  if (actual.rows.pricing)
    Object.assign(mutations, {
      price_row_dropped: (a) => {
        delete a.groups.pricing[Object.keys(a.groups.pricing)[0]];
      },
      price_count_changed: (a) => {
        a.rows.pricing++;
      },
      unit_cost_changed: (a) => {
        a.price_sample.find((q) => q.rows.length).rows[0][2] = "999999.0000";
      },
      days_supply_changed: (a) => {
        a.price_sample.find((q) => q.rows.length).rows[0][1]++;
      },
    });
  return Object.fromEntries(
    Object.entries(mutations).map(([name, mutate]) => {
      const copy = structuredClone(actual);
      mutate(copy);
      return [name, compareLarge(expected, copy).length > 0];
    }),
  );
}
