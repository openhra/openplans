import type { Database } from "../../db/database.js";
import { readCachedText, sidecarNames } from "../../fetch/index.js";
import type { SnapshotReadOptions } from "../../fetch/index.js";
import { acquireQhpChildren } from "./formulary-acquire.js";
import type { AcquisitionOptions } from "./formulary-acquire.js";
import { sourceSet } from "./provider-repository.js";
import type { ProviderScope } from "./provider-repository.js";
import { importProviders } from "./provider.js";
import type { ProviderOptions } from "./provider.js";

export const acquireProviders = (
  db: Database,
  scope: ProviderScope,
  options?: AcquisitionOptions,
) => acquireQhpChildren(db, scope, "provider_urls", options);

/**
 * The SHA-256 of the one cached snapshot under `raw/<source>`, read through the fetch cache's
 * store, so a repeat run can pin the download it already holds. It returns undefined when the
 * source holds no snapshot, holds several, or cannot be read, and the acquire step then
 * downloads as usual.
 */
export async function soleCachedHash(
  dataDir: string,
  source: string,
  options: SnapshotReadOptions = {},
): Promise<string | undefined> {
  try {
    const names = await sidecarNames(dataDir, source, options);
    if (names.length !== 1) return undefined;
    return (
      JSON.parse(await readCachedText(dataDir, source, names[0]!, options)) as {
        sha256?: string;
      }
    ).sha256;
  } catch {
    return undefined;
  }
}

/** Acquire definitions first, then stream each child before waiting for the next download. */
export async function ingestProviders(
  db: Database,
  scope: ProviderScope,
  options: AcquisitionOptions & Pick<ProviderOptions, "onShard"> = {},
) {
  const set = await sourceSet(db, scope);
  await acquireQhpChildren(db, scope, "provider_urls", {
    ...options,
    childIds: set.children
      .filter((c) => c.kind === "plan_urls")
      .map((c) => c.child_id),
  });
  return importProviders(db, scope, {
    ...options,
    prepareChild: async (child, session) => {
      await acquireQhpChildren(session, scope, "provider_urls", {
        ...options,
        childIds: [child.child_id],
      });
      return (
        (await sourceSet(session, scope)).children.find(
          (c) => c.child_id === child.child_id,
        ) ?? child
      );
    },
  });
}
