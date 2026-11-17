import type { SqlSession } from "@openplans/plugin-sdk";
import { writeTargets } from "../../plugins/sources/scoped-writer.js";

export class OperatorCommandRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OperatorCommandRefused";
  }
}
export const refuse = (code: string): never => {
  throw new OperatorCommandRefused(code);
};

// Owner repositories use parameterized DML. Unknown functions and qualified calls are closed.
const functions = new Set([
  "count",
  "sum",
  "min",
  "max",
  "coalesce",
  "nullif",
  "greatest",
  "least",
  "jsonb_build_object",
  "jsonb_build_array",
  "jsonb_set",
  "to_jsonb",
  "array",
  "any",
  "all",
  "in",
  "exists",
  "values",
  "as",
  "filter",
  "over",
  "conflict",
]);
export function commandSqlAllowed(sql: string, tables: ReadonlySet<string>) {
  const targets = writeTargets(sql);
  if (targets === null || targets.some((table) => !tables.has(table)))
    return false;
  // Remove data literals/comments, then inspect calls. No dollar strings, quoted calls or
  // escape strings: they are unnecessary in parameterized repository statements.
  if (/\$[a-z_]*\$|\bE'|\/\*/i.test(sql)) return false;
  const syntax = sql.replace(/'(?:''|[^'])*'/g, "''").replace(/--[^\n]*/g, "");
  if (/"[^"\n]*"\s*\(/.test(syntax)) return false;
  for (const match of syntax.matchAll(/([a-z_][a-z0-9_$]*)\s*\(/gi)) {
    const word = match[1]!.toLowerCase();
    // An INSERT's column list is the sole table-shaped call.
    if (
      tables.has(word) &&
      new RegExp(`\\binsert\\s+into\\s+${word}\\s*\\(`, "i").test(syntax)
    )
      continue;
    if (!functions.has(word) || /\.\s*$/.test(syntax.slice(0, match.index)))
      return false;
  }
  return true;
}
export function commandSession(
  tx: SqlSession,
  tables: readonly string[],
  signal: AbortSignal,
) {
  const allowed = new Set(tables);
  let open = true;
  let failure: unknown;
  const session: SqlSession = Object.freeze({
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      try {
        if (!open || signal.aborted) return refuse("operator_command_deadline");
        if (failure) throw failure;
        if (!commandSqlAllowed(sql, allowed))
          return refuse("operator_command_sql_scope");
        const result = await tx.query<Row>(sql, parameters);
        signal.throwIfAborted();
        return result;
      } catch (error) {
        failure ??= error;
        throw error;
      }
    },
    async exec(sql: string) {
      await session.query(sql);
    },
  });
  return {
    db: session,
    check: () => {
      if (failure) throw failure;
    },
    close: () => {
      open = false;
    },
  };
}
