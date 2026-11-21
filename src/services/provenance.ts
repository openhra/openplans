import { servingPolicy, requireAnnualYear } from "./data-window.js";
import type { SqlSession } from "../db/database.js";
import { snapshotMetadata } from "../api/repository.js";
import { dataGeneration } from "../db/generation.js";
import { dataAvailability } from "./availability.js";
import * as v from "../api/validation.js";

export async function getSnapshot(db: SqlSession, id: unknown) {
  if (
    typeof id !== "string" ||
    !id.length ||
    id.length > 1024 ||
    // eslint-disable-next-line no-control-regex -- Control characters must be rejected at this boundary.
    /[\u0000-\u001f]/.test(id)
  )
    return v.fail("snapshot_id");
  return snapshotMetadata(db, id);
}
/** Generation lookup failures propagate; callers must bypass caching rather than invent a generation. */
export async function getDataStatus(
  db: SqlSession,
  params: { state?: string; year?: string; issuer_id?: string } = {},
) {
  const state = params.state === undefined ? undefined : v.state(params.state);
  const year = params.year === undefined ? undefined : v.year(params.year);
  if (year !== undefined) await requireAnnualYear(db, year);
  const data_policy = await servingPolicy(db);
  const generation = await dataGeneration(db);
  const entries = (await dataAvailability(db)).filter(
    (row) =>
      (state === undefined || row.state === state) &&
      (year === undefined || row.plan_year === year) &&
      (params.issuer_id === undefined || row.issuer_id === params.issuer_id),
  );
  return { data_generation: generation, data_policy, entries };
}
