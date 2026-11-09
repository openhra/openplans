import type { Database } from "../../db/database.js";
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
