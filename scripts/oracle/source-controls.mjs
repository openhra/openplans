import { replaceSyntax } from "../source-mutation.mjs";

// Shared by the executable controls and their offline target checks.
export const sourceControls = {
  dental: {
    path: "domain/rating/dental",
    before: "suffix = 'TwoDependents';",
    after: "suffix = 'ThreeOrMoreDependents';",
  },
  csr: {
    path: "api/validation",
    before: "const csr = csrVariant(body.csr_variant);",
    after:
      "const csr = csrVariant(body.csr_variant ?? (typeof body.household_income_annual === 'number' ? 'csr94' : undefined));",
  },
  communityGuard: {
    path: "domain/rating/rate-row",
    before: "['NY', 'VT'].includes(row.stateCode) ||",
    after: "",
  },
  filedFamilyCell: {
    path: "domain/rating/community-family",
    before: "const price = rate.prices[tier];",
    after:
      "const price = Math.round(rate.prices.single * rule.tiers[tier] / rule.denominator);",
  },
  alaskaFpl: {
    path: "domain/subsidy/aptc",
    before: "region = 'alaska';",
    after: "region = 'contiguous';",
  },
  zctaPriority: {
    path: "ingest/geo/repository",
    before: "if (rows.length) return",
    after:
      "const mutant = await fallbackCounties(db, zip, 'geonames'); if (mutant.length) return { zip, status: 'available', geography: 'postal_zip', source: 'geonames', counties: mutant }; if (rows.length) return",
  },
};

export function mutateSource(source, control) {
  return replaceSyntax(source, control.before, control.after);
}
