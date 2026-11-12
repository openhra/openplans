/**
 * NY approved-template guard, checked again at import. `prepare.py` records one check per
 * DFS approved-rates template. A template whose workbook was last saved before its filing's
 * submission date cannot hold the rates DFS approved later, and a template without usable
 * date evidence proves nothing either. The importer refuses both. The issuer's NY rates
 * stay `unknown`, and provenance keeps the refusal and its evidence.
 */
export const TEMPLATE_GUARD_RULE =
  "ny-approved-template-saved-on-or-after-submission-v1";

export type TemplateRefusalReason =
  | "template_saved_date_unavailable"
  | "submission_date_unavailable"
  | "submission_date_ambiguous"
  | "template_saved_before_submission";

interface WorkbookDate {
  member: string;
  saved_at: string | null;
}
interface SubmissionSource {
  url: string;
  sha256: string;
  members: string[];
  dates: string[];
}
export interface TemplateCheck {
  url: string;
  sha256: string;
  bytes: number;
  retrieved_at: string;
  content_type: string | null;
  filing: string;
  issuer_ids: string[];
  decision: "admitted" | "refused";
  status: "filed" | "unknown";
  reason: TemplateRefusalReason | null;
  evidence: {
    rule: typeof TEMPLATE_GUARD_RULE;
    workbooks: WorkbookDate[];
    submission_date: string | null;
    submission_source: SubmissionSource | null;
  };
  /** Refused checks only: the plans and regions the template lists, never its rates. */
  listed_plans?: ListedPlan[];
}
export interface ListedPlan {
  plan_id: string;
  region: string;
}
interface GuardedSource {
  url: string;
  sha256: string;
  records: { issuer: string }[];
}

const MAX_TEMPLATES = 12;
const MAX_LISTED_PLANS = 5000;
const PLAN_ID = /^\d{5}NY\d{7}$/;
const REGION = /^Rating Area [1-8]$/;
const SAVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SUBMISSION_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILENAME_DATE = /^\d{8}$/;
const FILING = /_([A-Z]{4}-\d{9})_ApprRatesTemplate$/;
const FINAL_EXHIBITS =
  /^https:\/\/myportal\.dfs\.ny\.gov\/documents\/538523\/45010894\/[A-Za-z_]+_IND_(?:BOTHX|ONX)_[A-Z]{4}-\d{9}_FinalExhibits$/;

const shortText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 1000;
const stringList = (value: unknown, pattern?: RegExp): value is string[] =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((item) => shortText(item) && (!pattern || pattern.test(item)));

/** The same decision `prepare.py` makes, from the recorded evidence alone. */
export function templateRefusalReason(
  evidence: TemplateCheck["evidence"],
): TemplateRefusalReason | null {
  const { workbooks, submission_date, submission_source } = evidence;
  if (!workbooks.length || workbooks.some((w) => w.saved_at === null))
    return "template_saved_date_unavailable";
  if (submission_date === null)
    return submission_source?.dates.length
      ? "submission_date_ambiguous"
      : "submission_date_unavailable";
  const earliestSave = workbooks
    .map((w) => w.saved_at!.slice(0, 10))
    .sort()[0]!;
  return earliestSave < submission_date
    ? "template_saved_before_submission"
    : null;
}

function validSubmissionSource(
  value: SubmissionSource | null,
  filing: string,
): boolean {
  if (value === null) return true;
  return (
    typeof value === "object" &&
    typeof value.url === "string" &&
    FINAL_EXHIBITS.test(value.url) &&
    value.url.endsWith(`_${filing}_FinalExhibits`) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    stringList(value.members) &&
    value.members.every((member) => member.includes(`_${filing}_IN_`)) &&
    stringList(value.dates, FILENAME_DATE)
  );
}

function submissionDateMatches(evidence: TemplateCheck["evidence"]) {
  const dates = evidence.submission_source?.dates ?? [];
  const expected =
    dates.length === 1
      ? `${dates[0]!.slice(0, 4)}-${dates[0]!.slice(4, 6)}-${dates[0]!.slice(6)}`
      : null;
  return evidence.submission_date === expected;
}

/** A refused check must say where its plans are, so benchmarks know what they lack. */
function validListedPlans(check: TemplateCheck) {
  const plans = check.listed_plans;
  if (check.decision !== "refused") return plans === undefined;
  if (
    !Array.isArray(plans) ||
    !plans.length ||
    plans.length > MAX_LISTED_PLANS ||
    plans.some(
      (p) =>
        !p ||
        typeof p !== "object" ||
        Object.keys(p).length !== 2 ||
        typeof p.plan_id !== "string" ||
        !PLAN_ID.test(p.plan_id) ||
        typeof p.region !== "string" ||
        !REGION.test(p.region),
    )
  )
    return false;
  const issuers = [...new Set(plans.map((p) => p.plan_id.slice(0, 5)))].sort();
  return (
    new Set(plans.map((p) => `${p.plan_id}|${p.region}`)).size ===
      plans.length &&
    JSON.stringify(issuers) === JSON.stringify([...check.issuer_ids].sort())
  );
}

function validCheck(
  check: TemplateCheck,
  urlAllowed: (url: unknown) => boolean,
) {
  const filing = typeof check?.url === "string" ? FILING.exec(check.url) : null;
  const evidence = check?.evidence;
  if (
    !filing ||
    !urlAllowed(check.url) ||
    check.filing !== filing[1] ||
    !/^[a-f0-9]{64}$/.test(check.sha256) ||
    !Number.isSafeInteger(check.bytes) ||
    check.bytes <= 0 ||
    !shortText(check.retrieved_at) ||
    !Number.isFinite(Date.parse(check.retrieved_at)) ||
    !stringList(check.issuer_ids, /^\d{5}$/) ||
    !check.issuer_ids.length ||
    !evidence ||
    evidence.rule !== TEMPLATE_GUARD_RULE ||
    !Array.isArray(evidence.workbooks) ||
    evidence.workbooks.some(
      (w) =>
        !w ||
        !shortText(w.member) ||
        (w.saved_at !== null &&
          !(typeof w.saved_at === "string" && SAVED_AT.test(w.saved_at))),
    ) ||
    (evidence.submission_date !== null &&
      !(
        typeof evidence.submission_date === "string" &&
        SUBMISSION_DATE.test(evidence.submission_date)
      )) ||
    !validSubmissionSource(evidence.submission_source, check.filing) ||
    !submissionDateMatches(evidence)
  )
    return false;
  const reason = templateRefusalReason(evidence);
  return (
    check.reason === reason &&
    check.decision === (reason ? "refused" : "admitted") &&
    check.status === (reason ? "unknown" : "filed") &&
    validListedPlans(check)
  );
}

/** Every served NY source needs an admitted check for the same bytes; refused templates
 * must not be served. Returns the refused checks so the importer can record them. */
export function validateTemplateChecks(
  checks: unknown,
  sources: readonly GuardedSource[],
  urlAllowed: (url: unknown) => boolean,
): TemplateCheck[] {
  if (
    !Array.isArray(checks) ||
    !checks.length ||
    checks.length > MAX_TEMPLATES ||
    new Set(checks.map((c: TemplateCheck) => c?.url)).size !== checks.length ||
    checks.some((check: TemplateCheck) => !validCheck(check, urlAllowed))
  )
    throw new Error("Invalid NY template check");
  const byUrl = new Map(
    (checks as TemplateCheck[]).map((check) => [check.url, check]),
  );
  for (const source of sources) {
    const check = byUrl.get(source.url);
    const issuers = [...new Set(source.records.map((r) => r.issuer))].sort();
    if (
      check?.decision !== "admitted" ||
      check.sha256 !== source.sha256 ||
      JSON.stringify(issuers) !== JSON.stringify(check.issuer_ids)
    )
      throw new Error("NY source lacks an admitted template check");
  }
  const served = new Set(sources.map((source) => source.url));
  for (const check of checks as TemplateCheck[]) {
    if (check.decision === "admitted" && !served.has(check.url))
      throw new Error("Admitted NY template is missing from sources");
  }
  return (checks as TemplateCheck[]).filter((c) => c.decision === "refused");
}
