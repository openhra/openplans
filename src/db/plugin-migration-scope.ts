import { migrationStatements } from "./migrate-safety.js";
import type { MigrationStatement } from "./migrate-safety.js";

/**
 * Design 5.13: a plugin migration may only create or alter objects named `plg_<prefix>_...`.
 * The check reads the statement tokens, not a full SQL grammar, so it allows a short list of
 * statement shapes and refuses everything else: CREATE TABLE, CREATE INDEX, CREATE FUNCTION,
 * ALTER TABLE and INSERT INTO, each naming a prefixed object in the `public` schema.
 */
export function pluginTableName(prefix: string): string {
  return `plg_${prefix}_`;
}

const IDENTIFIER = /^(?:[A-Z_][A-Z0-9_$]*|"(?:[^"]|"")+")$/;

function identifierName(token: string | undefined): string | undefined {
  if (!token || !IDENTIFIER.test(token)) return undefined;
  return token.startsWith('"')
    ? token.slice(1, -1).replaceAll('""', '"')
    : token.toLowerCase();
}

/** A relation name at `index`, optionally qualified by `public`. */
function relationAt(
  tokens: readonly string[],
  index: number,
): { name: string; next: number } | undefined {
  const first = identifierName(tokens[index]);
  if (first === undefined) return undefined;
  if (tokens[index + 1] !== ".") return { name: first, next: index + 1 };
  const name = identifierName(tokens[index + 2]);
  if (first !== "public" || name === undefined) return undefined;
  return { name, next: index + 3 };
}

function optional(
  tokens: readonly string[],
  index: number,
  words: readonly string[],
): number {
  return words.every((word, offset) => tokens[index + offset] === word)
    ? index + words.length
    : index;
}

function contains(tokens: readonly string[], words: readonly string[]) {
  return tokens.some((_, index) =>
    words.every((word, offset) => tokens[index + offset] === word),
  );
}

/** Undefined when the statement stays inside the prefix; otherwise why it does not. */
function statementScope(
  statement: MigrationStatement,
  prefix: string,
): string | undefined {
  const tokens = statement.tokens;
  const owned = (name: string | undefined) =>
    name !== undefined &&
    name.startsWith(prefix) &&
    name.length > prefix.length;
  const target = (index: number) => {
    const relation = relationAt(tokens, index);
    return relation && owned(relation.name) ? relation : undefined;
  };
  let i = 0;
  if (tokens[0] === "CREATE") {
    i = optional(tokens, 1, ["OR", "REPLACE"]);
    i = optional(tokens, i, ["UNLOGGED"]);
    i = optional(tokens, i, ["UNIQUE"]);
    const kind = tokens[i++];
    if (kind === "TABLE") {
      i = optional(tokens, i, ["IF", "NOT", "EXISTS"]);
      if (!target(i)) return "table outside the plugin prefix";
      // A partition or child of another table changes that table.
      if (contains(tokens, ["PARTITION", "OF"]) || tokens.includes("INHERITS"))
        return "table attached to another table";
      return undefined;
    }
    if (kind === "INDEX") {
      i = optional(tokens, i, ["CONCURRENTLY"]);
      i = optional(tokens, i, ["IF", "NOT", "EXISTS"]);
      if (tokens[i] !== "ON") {
        const index = target(i);
        if (!index) return "index outside the plugin prefix";
        i = index.next;
      }
      if (tokens[i++] !== "ON") return "unrecognised index statement";
      i = optional(tokens, i, ["ONLY"]);
      return target(i) ? undefined : "index on a table outside the prefix";
    }
    if (kind === "FUNCTION")
      return target(i) ? undefined : "function outside the plugin prefix";
    return "statement kind not allowed in a plugin migration";
  }
  if (tokens[0] === "ALTER" && tokens[1] === "TABLE") {
    i = optional(tokens, 2, ["IF", "EXISTS"]);
    i = optional(tokens, i, ["ONLY"]);
    const table = target(i);
    if (!table) return "table outside the plugin prefix";
    const rest = tokens.slice(table.next);
    if (
      contains(rest, ["SET", "SCHEMA"]) ||
      rest.includes("ATTACH") ||
      rest.includes("DETACH") ||
      rest.includes("INHERIT")
    )
      return "alteration reaches outside the plugin prefix";
    if (
      rest[0] === "RENAME" &&
      rest[1] === "TO" &&
      !owned(identifierName(rest[2]))
    )
      return "rename outside the plugin prefix";
    return undefined;
  }
  if (tokens[0] === "INSERT" && tokens[1] === "INTO")
    return target(2) ? undefined : "insert outside the plugin prefix";
  return "statement kind not allowed in a plugin migration";
}

/**
 * The first statement of `sql` that leaves the `plg_<prefix>_` namespace, as
 * `statement N: why`, or undefined when every statement stays inside it. SQL the statement
 * splitter cannot read is out of scope too.
 */
export function pluginMigrationScope(
  sql: string,
  tablePrefix: string,
): string | undefined {
  let statements: MigrationStatement[];
  try {
    statements = migrationStatements(sql);
  } catch {
    return "statement 1: unreadable SQL";
  }
  const prefix = pluginTableName(tablePrefix);
  for (const [index, statement] of statements.entries()) {
    const reason = statementScope(statement, prefix);
    if (reason) return `statement ${index + 1}: ${reason}`;
  }
  return undefined;
}
