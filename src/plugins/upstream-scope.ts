import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-request disclosure scope behind `x-openplans-upstream` (provrxplan 4.5, D-PRX-5). It
 * lives in a module of its own so the pass-through core can record a live call it starts, failed
 * or refused upstream included, while the host's disclosure layer reads the same scope. One scope
 * runs per inbound request; a nested scope (an MCP tool call inside the MCP HTTP request) passes
 * its sources up.
 */
interface Disclosure {
  declined: boolean;
  readonly sources: Set<string>;
  readonly parent: Disclosure | undefined;
}
const disclosure = new AsyncLocalStorage<Disclosure>();

/** Runs `fn` in a new disclosure scope; a nested scope inherits its parent's opt-out. */
export function withUpstreamDisclosure<T>(
  fn: () => Promise<T>,
  declined = false,
): Promise<T> {
  const parent = disclosure.getStore();
  const own: Disclosure = {
    declined: declined || (parent?.declined ?? false),
    sources: new Set(),
    parent,
  };
  return disclosure.run(own, fn);
}

/** Marks the current request scope as declining pass-through. */
export function declineInScope(): void {
  const current = disclosure.getStore();
  if (current) current.declined = true;
}

/** True when the current request scope declined pass-through. */
export function declinedInScope(): boolean {
  return disclosure.getStore()?.declined ?? false;
}

/** Source ids recorded in the current scope, sorted; empty outside a scope. */
export function upstreamSources(): string[] {
  return [...(disclosure.getStore()?.sources ?? [])].sort();
}

/** Records source ids in the current scope and every parent scope; nothing outside a scope. */
export function recordUpstream(ids: Iterable<string>): void {
  for (const id of ids)
    for (let s = disclosure.getStore(); s; s = s.parent) s.sources.add(id);
}
