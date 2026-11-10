// PostgreSQL messages can contain quoted values, connection URIs or arbitrary RAISE text.
// Only known diagnostic templates are printable; detail, hint, where and stack stay private.
const diagnosticTemplates = [
  /^could not (?:resize|create|map) shared memory segment \[redacted\](?: to \d+ bytes)?: (?:No space left on device|Cannot allocate memory|Permission denied)$/,
  /^(?:out of memory|out of shared memory|disk full|too many clients already|remaining connection slots are reserved for non-replication superuser connections)$/,
  /^canceling statement due to (?:statement timeout|lock timeout|user request)$/,
  /^(?:relation|column|function|database|role) \[redacted\] does not exist$/,
  /^syntax error at or near \[redacted\]$/,
  /^permission denied for (?:table|schema|database|relation) \[redacted\]$/,
  /^password authentication failed for user \[redacted\]$/,
  /^duplicate key value violates unique constraint \[redacted\]$/,
  /^null value in column \[redacted\] of relation \[redacted\] violates not-null constraint$/,
  /^invalid input syntax for type (?:integer|bigint|numeric|uuid|json|boolean): \[redacted\]$/,
  /^(?:deadlock detected|current transaction is aborted, commands ignored until end of transaction block)$/,
];

export function databaseErrorDiagnostic(error: unknown): string {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !/^[0-9A-Z]{5}$/.test(error.code)
  )
    return "";
  const message = error.message.replace(
    /"(?:[^"\\]|\\.|"")*"|'(?:[^'\\]|\\.|'')*'/g,
    "[redacted]",
  );
  const safe = diagnosticTemplates.some((template) => template.test(message));
  return `; PostgreSQL ${error.code}: ${safe ? message : "message withheld because it may contain sensitive values"}`;
}
