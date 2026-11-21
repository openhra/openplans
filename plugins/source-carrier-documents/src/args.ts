import { z } from "zod";

export interface IssuerScope {
  state: string;
  issuerId: string;
}

/** What one `worker ingest carrier-formulary` run reads and for whom. */
export interface FormularyRun {
  discovery: string[];
  issuers: IssuerScope[];
  years: number[];
}

const ISSUER = /^([A-Z]{2}):([0-9]{5})$/;
const YEARS = /^(20[0-9]{2})(?:,(20[0-9]{2}))*$/;

/** Parse `--discovery URL`, `--issuer ST:NNNNN` (both repeatable) and `--years 2026,2027`. */
function parseRun(argv: string[], ctx: z.RefinementCtx): FormularyRun {
  const run: FormularyRun = { discovery: [], issuers: [], years: [] };
  const fail = (message: string) => {
    ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  };
  for (let at = 0; at < argv.length; at += 2) {
    const [flag, value] = [argv[at], argv[at + 1]];
    if (value === undefined) return fail(`${flag} needs a value`);
    if (flag === "--discovery") {
      if (!URL.canParse(value) || new URL(value).protocol !== "https:")
        return fail("--discovery must be an https URL");
      run.discovery.push(value);
    } else if (flag === "--issuer") {
      const match = ISSUER.exec(value);
      if (!match) return fail("--issuer must look like TX:12345");
      run.issuers.push({ state: match[1]!, issuerId: match[2]! });
    } else if (flag === "--years") {
      if (run.years.length || !YEARS.test(value))
        return fail("--years must appear once, like 2026,2027");
      run.years = [...new Set(value.split(",").map(Number))].sort();
    } else return fail(`unknown option ${flag}`);
  }
  if (!run.discovery.length || !run.issuers.length || !run.years.length)
    return fail("--discovery, --issuer and --years are required");
  const issuerIds = run.issuers.map((issuer) => issuer.issuerId);
  if (new Set(issuerIds).size !== issuerIds.length)
    return fail("each --issuer once");
  return run;
}

export const formularyArgs = z.array(z.string()).transform(parseRun);
