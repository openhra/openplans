export type CmsFallbackFailure = "policy_failed" | "policy_timeout";
let unavailable = false;

export function cmsFallbackUnavailable(): boolean {
  return unavailable;
}

/** A process-local hold applies to stored and live CMS answers until policy is verified again. */
export function disableCmsFallback(reason: CmsFallbackFailure): void {
  if (unavailable) return;
  unavailable = true;
  console.warn(JSON.stringify({ event: "cms_fallback_unavailable", reason }));
}

export function enableCmsFallback(): void {
  unavailable = false;
}
