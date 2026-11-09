/** Problems with the shipped publisher manifests; an empty list passes the release check. */
export function reviewProblems(
  manifest: unknown,
  policy: unknown,
  now?: Date,
): string[];
