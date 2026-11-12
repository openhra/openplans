import type { CacheLevel, OpenPlansPlugin } from "@openplans/plugin-sdk";
export const HOST: string;
/**
 * A synthetic drug pass-through source declared at `level`; with `coreEvidence` it has no `serve`
 * hook and answers carry the core's default evidence block.
 */
export function syntheticSource(
  level?: CacheLevel,
  options?: { coreEvidence?: boolean },
): unknown;
declare const plugin: OpenPlansPlugin;
export default plugin;
