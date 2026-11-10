/** A SQL allow-list, not a proof of application compatibility or a PostgreSQL parser. */
export interface MigrationSafety {
  classification: "additive-safe" | "risky";
  reasons: string[];
}

export interface MigrationStatement {
  sql: string;
  tokens: string[];
}

/** Keep bodies and quoted values opaque; only unquoted semicolons end statements. */
export function migrationStatements(sql: string): MigrationStatement[] {
  const statements: MigrationStatement[] = [];
  let tokens: string[] = [];
  let start = 0;
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (/^\s/.test(rest)) {
      i++;
      continue;
    }
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error("Unterminated SQL comment");
      continue;
    }
    const dollar = /^(\$(?:[a-z_][a-z0-9_]*)?\$)/i.exec(rest)?.[1];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error("Unterminated SQL body");
      tokens.push("<BODY>");
      i = end + dollar.length;
      continue;
    }
    const escaped = /^[eE]'/.test(rest);
    const quote = escaped ? "'" : sql[i];
    if (quote === "'" || quote === '"') {
      const begin = i;
      i += escaped ? 2 : 1;
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i++] === quote) {
          if (sql[i] === quote) {
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unterminated SQL quote");
      tokens.push(sql.slice(begin, i));
      continue;
    }
    if (sql[i] === ";") {
      if (depth !== 0) throw new Error("Unbalanced SQL parentheses");
      if (depth !== 0) throw new Error("Unbalanced SQL parentheses");
      if (tokens.length) statements.push({ sql: sql.slice(start, i), tokens });
      tokens = [];
      start = ++i;
      continue;
    }
    const token =
      /^[a-z_][a-z0-9_$]*|^\d+(?:\.\d+)?(?:e[+-]?\d+)?|^::|^[<>!=]=|^./i.exec(
        rest,
      )![0];
    if (token === "(") depth++;
    if (token === ")" && --depth < 0)
      throw new Error("Unbalanced SQL parentheses");
    tokens.push(token.toUpperCase());
    i += token.length;
  }
  if (tokens.length) statements.push({ sql: sql.slice(start), tokens });
  return statements;
}

const identifier = '(?:[A-Z_][A-Z0-9_$]*|"(?:[^"]|"")+")';
const relation = `${identifier}(?: \\. ${identifier})?`;
const builtinType =
  "(?:TEXT|BOOLEAN|BOOL|SMALLINT|INTEGER|INT|BIGINT|REAL|DOUBLE PRECISION|NUMERIC(?: \\( \\d+(?: , \\d+)? \\))?|DECIMAL(?: \\( \\d+(?: , \\d+)? \\))?|UUID|JSONB?|BYTEA|DATE|INTERVAL|TIMESTAMPTZ|TIMESTAMP(?: WITH(?:OUT)? TIME ZONE)?|VARCHAR(?: \\( \\d+ \\))?)";
const literal =
  "(?:NULL|TRUE|FALSE|[+-]? ?\\d+(?:\\.\\d+)?(?:E[+-]?\\d+)?|'(?:[^']|'')*'|INTERVAL '(?:[^']|'')*')";
const constant = new RegExp(`^${literal}(?: :: ${builtinType})?$`, "i");

function columnAddition(tokens: string[]): boolean {
  let text = tokens.join(" ");
  const added = new RegExp(
    `^ADD COLUMN (?:IF NOT EXISTS )?(${identifier}) (${builtinType})(.*)$`,
  ).exec(text);
  if (!added) return false;
  text = added[3]!.trim();
  const notNull = /(?:^| )NOT NULL(?: |$)/.test(text);
  text = text.replace(/(?:^| )NOT NULL(?= |$)/, "").trim();
  if (!text) return !notNull;
  if (!text.startsWith("DEFAULT ")) return false;
  const value = text.slice(8).trim();
  return constant.test(value) && (!notNull || !/^NULL(?: |$)/.test(value));
}

function additions(tokens: string[]): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") depth++;
    if (token === ")") depth--;
    if (token === "," && depth === 0) parts.push([]);
    else parts[parts.length - 1]!.push(token);
  }
  return depth === 0 ? parts : [[]];
}

function completeTableDefinition(tokens: string[]): boolean {
  const first = tokens.indexOf("(");
  let depth = 0;
  for (let i = first; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    if (tokens[i] === ")" && --depth === 0) return i === tokens.length - 1;
  }
  return false;
}

export function concurrentIndex(statement: MigrationStatement): boolean {
  return /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY /.test(
    statement.tokens.join(" "),
  );
}

export function classifyMigration(sql: string): MigrationSafety {
  const reasons: string[] = [];
  const newTables = new Set<string>();
  let statements: MigrationStatement[];
  try {
    statements = migrationStatements(sql);
  } catch {
    return { classification: "risky", reasons: ["Unterminated SQL token"] };
  }
  if (statements.some(concurrentIndex) && statements.length !== 1)
    reasons.push(
      "Concurrent indexes must be the sole statement in a migration file",
    );
  if (
    statements.some(
      (s) =>
        concurrentIndex(s) && s.tokens.join(" ").includes(" IF NOT EXISTS "),
    )
  )
    reasons.push(
      "Concurrent IF NOT EXISTS can hide an invalid index from a failed build",
    );
  for (const [index, statement] of statements.entries()) {
    const text = statement.tokens.join(" ");
    let reason: string | undefined;
    const table = new RegExp(`^CREATE TABLE (${relation}) \\(`).exec(text);
    if (
      table &&
      statement.tokens.at(-1) === ")" &&
      completeTableDefinition(statement.tokens)
    ) {
      newTables.add(table[1]!);
    } else if (
      new RegExp(
        `^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${identifier} )?ON (?:ONLY )?(${relation}) (?:USING ${identifier} )?\\(`,
      ).test(text)
    ) {
      const target = new RegExp(
        ` ON (?:ONLY )?(${relation}) (?:USING ${identifier} )?\\(`,
      ).exec(text)![1]!;
      if (!concurrentIndex(statement) && !newTables.has(target))
        reason =
          "Non-concurrent index on an existing table; size and lock duration unknown";
    } else if (
      new RegExp(`^ALTER TABLE (?:ONLY )?${relation} ADD COLUMN `).test(text)
    ) {
      const first = statement.tokens.indexOf("ADD");
      if (!additions(statement.tokens.slice(first)).every(columnAddition))
        reason =
          "Column addition has no non-null constant default, an expression, constraint, or unknown type/action";
    } else if (
      new RegExp(`^CREATE FUNCTION ${relation} \\(`).test(text) &&
      / LANGUAGE (?:SQL|PLPGSQL)(?: |$)/.test(text) &&
      statement.tokens.some(
        (token, i) =>
          statement.tokens[i - 1] === "AS" &&
          (token === "<BODY>" || /^(?:[eE])?'/.test(token)),
      )
    ) {
      // Defining a function does not execute its body. Calling it remains risky.
    } else if (
      new RegExp(
        `^CREATE TRIGGER ${identifier} (?:BEFORE|AFTER|INSTEAD OF) `,
      ).test(text) &&
      / EXECUTE (?:FUNCTION|PROCEDURE) /.test(text)
    ) {
      // The new trigger's behavior still needs application review.
    } else {
      reason =
        "Unknown or non-additive statement; possible rewrite, scan, or long lock";
    }
    if (reason) reasons.push(`Statement ${index + 1}: ${reason}`);
  }
  return {
    classification: reasons.length ? "risky" : "additive-safe",
    reasons,
  };
}

/** Historical hashes belong to CI only. Runtime checks never exempt old SQL. */
export function missingContractNotes(
  migrations: { name: string; sql: string; sha256: string }[],
  historical: Record<string, string>,
  notes: string,
): string[] {
  return migrations
    .filter((migration) => {
      if (
        historical[migration.name] === migration.sha256 ||
        classifyMigration(migration.sql).classification === "additive-safe"
      )
        return false;
      const prose = notes.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, "");
      const section =
        prose.split(`### ${migration.name}\n`)[1]?.split(/\n###? /)[0] ?? "";
      return ![
        "Stage",
        "Expand release",
        "Compatibility",
        "Forward fix",
        "Lock budget",
      ].every((field) => new RegExp(`^${field}: \\S.+$`, "m").test(section));
    })
    .map((migration) => migration.name);
}
