/**
 * Writes the synthetic issuer fixtures in formulary/ and provider/.
 * Every identifier is invented: issuer IDs start with 000 (no HIOS issuer
 * uses that range), NPIs fail the NPI check digit, RxCUIs sit in a 99xxxxxxx
 * block far above any assigned concept, and phone numbers use the 555-01xx
 * range reserved for fiction. Run: node tests/fixtures/qhp/generate-issuer.mjs
 * The files are committed; tests/fixture-lineage.test.ts checks they match.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const ISSUER = "00010";
export const NOTICE =
  "Synthetic fixture. Every issuer, plan, NPI, RxCUI, name, address and phone number is invented and describes no real plan, provider or drug listing.";
const OTHER = { AZ: "00011", CO: "00012", FL: "00013", NC: "00014" };
const YEAR = 2026;
const pad = (n, width) => String(n).padStart(width, "0");
const planId = (k) => `${ISSUER}TX00100${pad(k, 2)}`;
const otherPlan = (state, k) => `${OTHER[state]}${state}00200${pad(k, 2)}`;

// Plans 1-22 are in the TX catalog; 23-26 have definitions only.
const CATALOG = Array.from({ length: 22 }, (_, i) => i + 1);
const DEFINED = Array.from({ length: 26 }, (_, i) => i + 1);
// Catalog plans 17-22 have definitions but no drug associations; 20-22 also
// declare GENERIC twice and no PREFERRED-GENERIC tier.
const DRUG_PLANS = DEFINED.filter((k) => k < 17 || k > 22);
const ODD_TIERS = new Set([20, 21, 22]);
const SILVER = new Set([4, 5, 9, 13, 15, 19]);
const GOLD = new Set([2, 6, 10, 11, 14, 17, 20, 22]);
const metal = (k) => {
  if (SILVER.has(k)) return "Silver";
  return GOLD.has(k) ? "Gold" : "Expanded Bronze";
};
const metalWord = (m) => (m === "Expanded Bronze" ? "Bronze" : m);

export function catalog() {
  const snapshot = `puf-${YEAR}-TX-synthetic:plan-attributes`;
  const plans = CATALOG.map((k) => ({
    snapshot_id: snapshot,
    source_row: 100 + k,
    plan_year: YEAR,
    state: "TX",
    issuer_id: ISSUER,
    base_plan_id: planId(k),
    market: "Individual",
    metal: metal(k),
    dental_only: false,
    network_id: "TXN001",
    service_area_id: k % 4 === 0 ? "TXS002" : "TXS001",
    plan_name: `Synthetic ${metal(k)} Plan ${pad(k, 2)}`,
    exchange_status: "Both",
    on_exchange: true,
    off_exchange: true,
  }));
  const variants = [];
  for (const plan of plans) {
    const m = metalWord(plan.metal);
    const kinds = [
      ["00", `Standard ${m} Off Exchange Plan`],
      ["01", `Standard ${m} On Exchange Plan`],
      ["02", "Zero Cost Sharing Plan Variation"],
      ["03", "Limited Cost Sharing Plan Variation"],
    ];
    if (plan.metal === "Silver")
      kinds.push(
        ["04", `73% AV Level ${m} Plan`],
        ["05", `87% AV Level ${m} Plan`],
        ["06", `94% AV Level ${m} Plan`],
      );
    for (const [suffix, type] of kinds)
      variants.push({
        variant_plan_id: `${plan.base_plan_id}-${suffix}`,
        base_plan_id: plan.base_plan_id,
        csr_suffix: suffix,
        csr_variation_type: type,
        variant_name:
          suffix < "02" ? plan.plan_name : `${plan.plan_name} ${type}`,
        source_row: plan.source_row,
        exchange_status: "Both",
      });
  }
  return { plans, variants };
}

const TIERS = [
  "PREFERRED-GENERIC",
  "GENERIC",
  "PREFERRED-BRAND",
  "NON-PREFERRED-BRAND",
  "SPECIALTY",
];
export function formularyPlans() {
  return DEFINED.map((k) => ({
    plan_id: planId(k),
    plan_id_type: "HIOS-PLAN-ID",
    years: [YEAR],
    formulary: (ODD_TIERS.has(k) ? ["GENERIC", ...TIERS.slice(1)] : TIERS).map(
      (drug_tier) => ({ drug_tier }),
    ),
  }));
}

// Concepts: ingredient, then three clinical drugs. The ingredient is listed in
// RxNorm but in no formulary, so it resolves to "unknown" coverage.
export const RXCUI = {
  ingredient: "990000101",
  lisinopril: "990000201",
  atorvastatin: "990000301",
  metforminEr: "990000401",
};
const NON_TX = [
  ["AZ", 1],
  ["AZ", 2],
  ["AZ", 3],
  ["CO", 1],
  ["CO", 2],
  ["CO", 3],
  ["FL", 1],
  ["FL", 2],
];
export function drugs() {
  const drug = (rxnorm_id, drug_name, txTier, coTier) => {
    const plans = [];
    const add = (plan_id, drug_tier) =>
      plans.push({
        plan_id_type: "HIOS-PLAN-ID",
        plan_id,
        drug_tier,
        prior_authorization: false,
        step_therapy: false,
        quantity_limit: false,
        years: [YEAR],
      });
    // Every TX association appears twice, as some published feeds repeat them.
    for (const k of DRUG_PLANS) add(planId(k), txTier);
    for (const [state, k] of NON_TX)
      add(otherPlan(state, k), state === "CO" ? coTier : txTier);
    for (const k of DRUG_PLANS) add(planId(k), txTier);
    return { rxnorm_id, drug_name, plans };
  };
  return [
    drug(
      RXCUI.lisinopril,
      "SYNTHETIC LISINOPRIL 5 MG TABLET",
      "PREFERRED-GENERIC",
      "GENERIC",
    ),
    drug(
      RXCUI.atorvastatin,
      "SYNTHETIC ATORVASTATIN 80 MG TABLET",
      "GENERIC",
      "GENERIC",
    ),
    drug(
      RXCUI.metforminEr,
      "SYNTHETIC METFORMIN ER 500 MG TABLET",
      "GENERIC",
      "GENERIC",
    ),
  ];
}

export function rxnorm() {
  const snapshot_id = "rxnorm-synthetic-2026-11-02";
  let rxaui = 990100000;
  const row = (rxcui, name, tty) => ({
    snapshot_id,
    rxcui,
    rxaui: String(++rxaui),
    name,
    tty,
    suppress: "N",
    source_record: rxaui - 990100000,
  });
  return [
    row(RXCUI.ingredient, "synthetic metformin", "IN"),
    row(RXCUI.lisinopril, "synthetic lisinopril 5 MG Oral Tablet", "SCD"),
    row(
      RXCUI.metforminEr,
      "24 HR synthetic metformin hydrochloride 500 MG Extended Release Oral Tablet",
      "SCD",
    ),
    row(RXCUI.atorvastatin, "synthetic atorvastatin 80 MG Oral Tablet", "SCD"),
    row(
      RXCUI.atorvastatin,
      "synthetic atorvastatin (as atorvastatin calcium) 80 MG Oral Tablet",
      "SY",
    ),
    row(RXCUI.ingredient, "synthetic metFORMIN", "TMSY"),
    row(RXCUI.lisinopril, "synthetic lisinopril 5 MG Oral Tablet", "PSN"),
    row(
      RXCUI.atorvastatin,
      "synthetic atorvastatin calcium 80 MG Oral Tablet",
      "PSN",
    ),
    row(
      RXCUI.metforminEr,
      "24 HR synthetic metFORMIN hydrochloride 500 MG Extended Release Oral Tablet",
      "TMSY",
    ),
    row(
      RXCUI.metforminEr,
      "synthetic metFORMIN HCl 500 MG 24HR Extended Release Oral Tablet",
      "PSN",
    ),
    row(
      RXCUI.metforminEr,
      "synthetic metformin HCl 500 MG 24 HR Extended Release Oral Tablet",
      "SY",
    ),
    row(
      RXCUI.metforminEr,
      "synthetic metFORMIN HCl 500 MG 24 HR Extended Release Oral Tablet",
      "TMSY",
    ),
  ];
}

// Plan definitions name a network tier that the provider records do not use,
// so participation must not depend on the two labels matching.
export function providerPlans() {
  return DEFINED.map((k) => ({
    plan_id: planId(k),
    plan_id_type: "HIOS-PLAN-ID",
    years: [YEAR],
    network: [{ network_tier: "SYNTHETICCONNECTNETWORK" }],
  }));
}

/** A ten-digit number starting with 1 whose NPI check digit is wrong. */
export function invalidNpi(serial) {
  const body = `1999900${pad(serial, 2)}`;
  let sum = 24; // the 80840 prefix contributes 24 to the Luhn sum
  for (let i = body.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = Number(body[i]) * (double ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  const valid = (10 - (sum % 10)) % 10;
  return `${body}${(valid + 1) % 10}`;
}

const address = (n, city, zip, state = "TX", unit) => ({
  address: `${100 * n} Synthetic Way`,
  city,
  phone: `(555) 010-${pad(n, 4)}`,
  state,
  zip,
  ...(unit ? { address_2: unit } : {}),
});
export function providerRecords() {
  const txPlans = CATALOG.map((k) => ({
    network_tier: "PREFERRED",
    plan_id: planId(k),
    plan_id_type: "HIOS-PLAN-ID",
    years: [YEAR],
  }));
  const other = (state, count) =>
    Array.from({ length: count }, (_, i) => ({
      network_tier: "PREFERRED",
      plan_id: otherPlan(state, i + 1),
      plan_id_type: "HIOS-PLAN-ID",
      years: [YEAR],
    }));
  const common = { accepting: "accepting", last_updated_on: "2026-11-03" };
  return [
    {
      npi: invalidNpi(1),
      type: "INDIVIDUAL",
      plans: txPlans,
      name: { first: "Example", last: "Clinician One" },
      addresses: [
        address(1, "San Antonio", "78232", "TX", "Suite 1"),
        address(2, "Austin", "78701", "TX", "Suite 2"),
        address(3, "Houston", "77030"),
      ],
      specialty: ["Synthetic Counseling", "Synthetic Social Work"],
      ...common,
    },
    {
      npi: invalidNpi(2),
      type: "INDIVIDUAL",
      plans: txPlans,
      name: { first: "Example", last: "Clinician Two", middle: "E" },
      addresses: [address(4, "Dallas", "75201", "TX", "Ste 4")],
      specialty: ["Synthetic Obstetrics"],
      ...common,
    },
    {
      npi: invalidNpi(3),
      type: "INDIVIDUAL",
      plans: txPlans,
      name: { first: "Example", last: "Clinician Three" },
      addresses: [
        "Dallas:75201",
        "Houston:77030",
        "Austin:78701",
        "San Antonio:78232",
        "El Paso:79901",
        "Lubbock:79401",
        "Waco:76701",
        "Tyler:75701",
        "Laredo:78040",
      ].map((s, i) => {
        const [city, zip] = s.split(":");
        return address(10 + i, city, zip, "TX", `Unit ${i + 1}`);
      }),
      specialty: ["Synthetic Psychiatry", "Synthetic Medication Management"],
      ...common,
    },
    {
      npi: invalidNpi(4),
      type: "INDIVIDUAL",
      plans: [...txPlans, ...other("NC", 4)],
      name: { first: "Example", last: "Clinician Four", middle: "D" },
      addresses: [
        address(20, "Dallas", "75201", "TX", "Ste 20"),
        address(21, "Houston", "77030"),
        {
          ...address(22, "Austin", "78701"),
          address: "Virtual visits only",
        },
        address(23, "El Paso", "79901"),
        address(24, "Charlotte", "28202", "NC"),
        address(25, "Raleigh", "27601", "NC", "Ste 25"),
      ],
      specialty: ["Synthetic Psychiatry"],
      ...common,
    },
    {
      npi: invalidNpi(5),
      type: "FACILITY",
      plans: [
        ...other("FL", 3),
        ...txPlans,
        ...other("AZ", 3),
        ...other("NC", 2),
      ],
      facility_name: "Synthetic Infusion Facility",
      facility_type: ["Synthetic Pharmacy Services", "Synthetic Home Infusion"],
      addresses: [
        address(30, "Houston", "77030"),
        address(31, "Miami", "33101", "FL", "Bldg 31"),
        address(32, "Dallas", "75201", "TX", "Ste 32"),
        address(33, "Phoenix", "85001", "AZ"),
        address(34, "Charlotte", "28202", "NC"),
      ],
      last_updated_on: "2026-11-03",
    },
    {
      npi: invalidNpi(6),
      type: "GROUP",
      plans: txPlans,
      group_name: "Synthetic Medical Group",
      addresses: [address(40, "El Paso", "79901")],
      specialty: ["Synthetic Rheumatology"],
      ...common,
    },
  ];
}

/** A truncated provider feed: plan associations cut mid-array, ending in a comma. */
export function truncatedTail() {
  const item = (plan_id) =>
    `{\n        "plan_id_type": "HIOS-PLAN-ID",\n        "plan_id": "${plan_id}",\n        "network_tier": "NETWORK",\n        "years": [\n          2026,\n          2027\n        ]\n      }`;
  const ids = Array.from(
    { length: 20 },
    (_, i) => `00015MN00300${pad(i + 1, 2)}`,
  );
  return `[\n${ids.map(item).join(",\n      ")},\n`;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha = (text) => createHash("sha256").update(text).digest("hex");
export function files() {
  const formulary = {
    "catalog.json": json(catalog()),
    "plans.json": json(formularyPlans()),
    "drugs.json": json(drugs()),
    "rxnorm.json": json(rxnorm()),
  };
  const provider = {
    "plans.json": json(providerPlans()),
    "records.json": json(providerRecords()),
    "truncated-tail.json": truncatedTail(),
  };
  const provenance = (set) =>
    json({
      synthetic: true,
      notice: NOTICE,
      generator: "tests/fixtures/qhp/generate-issuer.mjs",
      files: Object.fromEntries(
        Object.entries(set).map(([name, text]) => [
          name,
          { synthetic: true, sha256: sha(text) },
        ]),
      ),
    });
  return {
    formulary: { ...formulary, "provenance.json": provenance(formulary) },
    provider: { ...provider, "provenance.json": provenance(provider) },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [dir, set] of Object.entries(files()))
    for (const [name, text] of Object.entries(set))
      await writeFile(new URL(`./${dir}/${name}`, import.meta.url), text);
}
