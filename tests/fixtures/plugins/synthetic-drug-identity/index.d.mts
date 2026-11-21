import type { CacheLevel, OpenPlansPlugin } from "@openplans/plugin-sdk";
export const IDENTITY_HOST: string;
export const IDENTITY_PATH: string;
/** Maps the synthetic `{ concepts: [{ rxcui, status }] }` body; `active` confirms. */
export function mapConcepts(body: unknown, questions: unknown[]): unknown[];
/** A synthetic drug identity source declared at `level` (default `memory`). */
export function syntheticIdentitySource(
  level?: CacheLevel,
  overrides?: Record<string, unknown>,
): unknown;
declare const plugin: OpenPlansPlugin;
export default plugin;
