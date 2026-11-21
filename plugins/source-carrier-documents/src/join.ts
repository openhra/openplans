import type { SqlSession } from "@openplans/plugin-sdk";
import {
  IDENTITY_JOIN_DEFAULT_LOOKUPS,
  IDENTITY_JOIN_PACING_MS,
  IDENTITY_REFRESH_AGE_DAYS,
  IDENTITY_REUSE_DAYS,
  SERVED_CONFIDENCE,
} from "./constants.js";
import {
  IDENTITY_UNRESOLVED,
  matchCandidates,
  readPrintedName,
  TERM_TYPE,
} from "./identity.js";
import type { ReadName } from "./identity.js";
import { PASSTHROUGH_IDENTITY_SOURCE } from "./lookup.js";
import type { IdentityLookup, LookupEvidence } from "./lookup.js";

export const IDENTITY_TABLE = "plg_carrierdoc_row_identity";
/** The `identity_source` of rows resolved through the pass-through identity stage (RxNav). */
export const JOIN_IDENTITY_SOURCE = PASSTHROUGH_IDENTITY_SOURCE;

export interface JoinOptions {
  /** The plugin's `identityJoin` switch. Off: nothing is read, asked or written. */
  enabled: boolean;
  /** Live lookups this run may make (name searches plus confirmations). */
  maxLookups?: number;
  /** Waits before each live lookup; defaults to `IDENTITY_JOIN_PACING_MS`. */
  pace?: () => Promise<void>;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface JoinSummary {
  status: "off" | "complete" | "paused";
  /** Why a paused run stopped: `lookup_limit`, `aborted`, or the identity stage's reason. */
  stopped?: string;
  lookups: number;
  /** Resolved rows confirmed again this run, and rows whose RxCUI the source no longer confirms. */
  reconfirmed: number;
  dropped: number;
  resolved: number;
  unresolved: number;
  reused: number;
  reasons: Record<string, number>;
  /** Rows still without an identity entry. */
  pending: number;
}

interface PendingRow {
  snapshot_id: string;
  page: number;
  line: number;
  drug_name: string;
  name_key: string;
}

interface Joined {
  row: PendingRow;
  status: "resolved" | "unresolved";
  reason: string | null;
  query: string | null;
  matched: number;
  rxcui: string | null;
  concept: string | null;
  evidence: Record<string, unknown>;
  /** The source that resolved the row and when it last confirmed the RxCUI; null if unresolved. */
  source: string | null;
  confirmedAt: Date | null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Served rows of active documents that have no identity entry yet, in document order. */
const PENDING = `
  SELECT r.snapshot_id, r.page, r.line, r.drug_name, r.name_key
  FROM plg_carrierdoc_formulary_row r
  JOIN snapshot s ON s.snapshot_id = r.snapshot_id AND s.validation_state = 'ACTIVE'
  WHERE r.confidence = $1 AND r.unknown_reason IS NULL
    AND NOT EXISTS (SELECT 1 FROM ${IDENTITY_TABLE} i
      WHERE i.snapshot_id = r.snapshot_id AND i.page = r.page AND i.line = r.line)
  ORDER BY r.snapshot_id, r.page, r.line`;

async function pendingRows(db: SqlSession): Promise<PendingRow[]> {
  return (
    await db.query<PendingRow & Record<string, unknown>>(PENDING, [
      SERVED_CONFIDENCE,
    ])
  ).rows;
}

async function write(db: SqlSession, joined: readonly Joined[], at: Date) {
  if (!joined.length) return;
  await db.query(
    `INSERT INTO ${IDENTITY_TABLE}(snapshot_id,page,line,name_key,status,reason,query,matched,rxcui,
       concept_name,identity_source,evidence,joined_at,confirmed_at)
     SELECT j.snapshot_id, j.page, j.line, j.name_key, j.status, j.reason, j.query, j.matched, j.rxcui,
       j.concept_name, j.identity_source, j.evidence, $2::timestamptz, j.confirmed_at
     FROM jsonb_to_recordset($1::jsonb) AS j(snapshot_id text, page int, line int, name_key text,
       status text, reason text, query text, matched int, rxcui text, concept_name text,
       identity_source text, evidence jsonb, confirmed_at timestamptz)
     ON CONFLICT (snapshot_id, page, line) DO NOTHING`,
    [
      JSON.stringify(
        joined.map((j) => ({
          snapshot_id: j.row.snapshot_id,
          page: j.row.page,
          line: j.row.line,
          name_key: j.row.name_key,
          status: j.status,
          reason: j.reason,
          query: j.query,
          matched: j.matched,
          rxcui: j.rxcui,
          concept_name: j.concept,
          identity_source: j.status === "resolved" ? j.source : null,
          evidence: j.evidence,
          confirmed_at:
            j.status === "resolved" ? j.confirmedAt!.toISOString() : null,
        })),
      ),
      at.toISOString(),
    ],
  );
}

/**
 * Entries an earlier run made for the same printed names from a lookup, younger than
 * `IDENTITY_REUSE_DAYS`: the newest per name. Entries made without a lookup are recomputed.
 */
async function reusable(db: SqlSession, keys: readonly string[], at: Date) {
  const since = new Date(at.getTime() - IDENTITY_REUSE_DAYS * 86_400_000);
  const { rows } = await db.query<{
    name_key: string;
    status: "resolved" | "unresolved";
    reason: string | null;
    query: string;
    matched: number;
    rxcui: string | null;
    concept_name: string | null;
    evidence: Record<string, unknown>;
    identity_source: string | null;
    confirmed_at: Date | string | null;
    snapshot_id: string;
    page: number;
    line: number;
  }>(
    `SELECT DISTINCT ON (name_key) name_key, status, reason, query, matched, rxcui, concept_name, evidence,
       identity_source, confirmed_at, snapshot_id, page, line
     FROM ${IDENTITY_TABLE}
     WHERE name_key = ANY($1::text[]) AND query IS NOT NULL AND joined_at >= $2::timestamptz
     ORDER BY name_key, joined_at DESC`,
    [keys, since.toISOString()],
  );
  return new Map(rows.map((row) => [row.name_key, row]));
}

/** Resolved rows of active documents confirmed before `before`: the RxCUIs to confirm again. */
async function staleConfirmations(db: SqlSession, before: Date) {
  const { rows } = await db.query<{ rxcui: string }>(
    `SELECT DISTINCT i.rxcui FROM ${IDENTITY_TABLE} i
     JOIN snapshot s ON s.snapshot_id = i.snapshot_id AND s.validation_state = 'ACTIVE'
     WHERE i.status = 'resolved' AND coalesce(i.confirmed_at, i.joined_at) < $1::timestamptz
     ORDER BY i.rxcui`,
    [before.toISOString()],
  );
  return rows.map((row) => row.rxcui);
}

/**
 * The ingest-time RxCUI join (PDF-6). It first confirms again every resolved row whose RxCUI was
 * confirmed more than `IDENTITY_REFRESH_AGE_DAYS` ago (a row the source no longer confirms becomes
 * `unresolved`, `rxcui_not_confirmed`). Then, for each served row of an active formulary document
 * that has no identity entry, the printed name is read into ingredients (or brand), strengths and
 * dose form; the identity stage's name search is asked once per distinct query; a row is `resolved`
 * only when exactly one candidate matches name, strength and form and the identity stage then
 * confirms that RxCUI. Every other row is `unresolved` with a reason. Entries are written per
 * query, so a run stopped by the lookup limit, the budget or an outage resumes at the next query.
 * Off: nothing.
 */
export async function joinFormularyIdentities(
  db: SqlSession,
  lookup: IdentityLookup,
  options: JoinOptions,
): Promise<JoinSummary> {
  const summary: JoinSummary = {
    status: "off",
    lookups: 0,
    reconfirmed: 0,
    dropped: 0,
    resolved: 0,
    unresolved: 0,
    reused: 0,
    reasons: {},
    pending: 0,
  };
  if (!options.enabled) return summary;
  const maxLookups = options.maxLookups ?? IDENTITY_JOIN_DEFAULT_LOOKUPS;
  const pace =
    lookup.paced === false
      ? async () => {}
      : (options.pace ?? (() => sleep(IDENTITY_JOIN_PACING_MS)));
  const now = options.now ?? (() => new Date());
  const tally = (joined: readonly Joined[]) => {
    for (const j of joined) {
      if (j.status === "resolved") summary.resolved += 1;
      else {
        summary.unresolved += 1;
        summary.reasons[j.reason!] = (summary.reasons[j.reason!] ?? 0) + 1;
      }
    }
  };
  const ask = async <T>(call: () => Promise<T>): Promise<T | null> => {
    if (options.signal?.aborted) {
      summary.stopped = "aborted";
      return null;
    }
    if (summary.lookups >= maxLookups) {
      summary.stopped = "lookup_limit";
      return null;
    }
    await pace();
    summary.lookups += 1;
    return call();
  };
  const confirmations = new Map<
    string,
    {
      status: "confirmed" | "not_confirmed";
      evidence: LookupEvidence;
      at: Date;
    }
  >();

  // Stored identities are confirmed again before they age out of serving.
  const stale = await staleConfirmations(
    db,
    new Date(now().getTime() - IDENTITY_REFRESH_AGE_DAYS * 86_400_000),
  );
  for (const rxcui of stale) {
    const asked = await ask(() => lookup.confirm(rxcui));
    if (!asked) break;
    if (asked.status === "unavailable") {
      summary.stopped = asked.reason;
      break;
    }
    const at = now();
    confirmations.set(rxcui, { ...asked, at });
    const { rows } =
      asked.status === "confirmed"
        ? await db.query(
            `UPDATE ${IDENTITY_TABLE} SET confirmed_at = $2::timestamptz,
               evidence = jsonb_set(evidence, '{confirmation}', $3::jsonb)
             WHERE status = 'resolved' AND rxcui = $1 RETURNING 1`,
            [rxcui, at.toISOString(), JSON.stringify(asked.evidence)],
          )
        : await db.query(
            `UPDATE ${IDENTITY_TABLE} SET status = 'unresolved', reason = $2, rxcui = NULL,
               identity_source = NULL, confirmed_at = NULL,
               evidence = jsonb_set(evidence, '{confirmation}', $3::jsonb)
             WHERE status = 'resolved' AND rxcui = $1 RETURNING 1`,
            [
              rxcui,
              IDENTITY_UNRESOLVED.notConfirmed,
              JSON.stringify(asked.evidence),
            ],
          );
    if (asked.status === "confirmed") summary.reconfirmed += rows.length;
    else summary.dropped += rows.length;
  }
  if (summary.stopped) return finish(db, summary);

  const pending = await pendingRows(db);
  const at = now();

  // Rows whose printed name cannot be read never need a lookup.
  const unreadable: Joined[] = [];
  const groups = new Map<string, { row: PendingRow; name: ReadName }[]>();
  for (const row of pending) {
    const reading = readPrintedName(row.drug_name);
    if (!reading.ok) {
      unreadable.push(unresolvedRow(row, reading.reason, null, 0, {}));
      continue;
    }
    const group = groups.get(reading.name.query) ?? [];
    group.push({ row, name: reading.name });
    groups.set(reading.name.query, group);
  }
  await write(db, unreadable, at);
  tally(unreadable);

  // An earlier lookup for the same printed name is reused without asking again.
  const earlier = await reusable(
    db,
    [...groups.values()].flat().map(({ row }) => row.name_key),
    at,
  );
  const reused: Joined[] = [];
  for (const [query, group] of groups) {
    const left = group.filter(({ row }) => {
      const found = earlier.get(row.name_key);
      if (!found) return true;
      reused.push({
        row,
        status: found.status,
        reason: found.reason,
        query: found.query,
        matched: found.matched,
        rxcui: found.rxcui,
        concept: found.concept_name,
        evidence: {
          ...found.evidence,
          reused_from: {
            snapshot_id: found.snapshot_id,
            page: found.page,
            line: found.line,
          },
        },
        // A reused identity keeps its own confirmation time; it ages out like the original.
        source: found.identity_source,
        confirmedAt: found.confirmed_at ? new Date(found.confirmed_at) : null,
      });
      return false;
    });
    if (left.length) groups.set(query, left);
    else groups.delete(query);
  }
  await write(db, reused, at);
  tally(reused);
  summary.reused = reused.length;

  groups: for (const [query, group] of groups) {
    // A group whose rows all need one term type lets a local lookup narrow its list by it.
    const types = new Set(group.map(({ name }) => TERM_TYPE[name.kind]));
    const search = await ask(() =>
      lookup.searchName(query, types.size === 1 ? [...types][0] : undefined),
    );
    if (!search) break;
    if (search.status === "unavailable") {
      summary.stopped = search.reason;
      break;
    }
    const joined: Joined[] = [];
    for (const { row, name } of group) {
      const match = matchCandidates(name, search.candidates);
      const found = { name_search: search.evidence };
      if (match.status === "unresolved") {
        joined.push(
          unresolvedRow(row, match.reason, query, match.matched, found),
        );
        continue;
      }
      let confirmation = confirmations.get(match.rxcui);
      if (!confirmation) {
        const asked = await ask(() => lookup.confirm(match.rxcui));
        if (!asked) break groups;
        if (asked.status === "unavailable") {
          summary.stopped = asked.reason;
          break groups;
        }
        confirmation = { ...asked, at: now() };
        confirmations.set(match.rxcui, confirmation);
      }
      const evidence = { ...found, confirmation: confirmation.evidence };
      joined.push(
        confirmation.status === "confirmed"
          ? {
              row,
              status: "resolved",
              reason: null,
              query,
              matched: 1,
              rxcui: match.rxcui,
              concept: match.concept,
              evidence,
              source: lookup.sourceId,
              confirmedAt: confirmation.at,
            }
          : unresolvedRow(
              row,
              IDENTITY_UNRESOLVED.notConfirmed,
              query,
              1,
              evidence,
            ),
      );
    }
    await write(db, joined, now());
    tally(joined);
  }
  return finish(db, summary);
}

async function finish(
  db: SqlSession,
  summary: JoinSummary,
): Promise<JoinSummary> {
  summary.pending = (await pendingRows(db)).length;
  summary.status = summary.stopped ? "paused" : "complete";
  return summary;
}

function unresolvedRow(
  row: PendingRow,
  reason: string,
  query: string | null,
  matched: number,
  evidence: Record<string, unknown>,
): Joined {
  return {
    row,
    status: "unresolved",
    reason,
    query,
    matched,
    rxcui: null,
    concept: null,
    evidence,
    source: null,
    confirmedAt: null,
  };
}
