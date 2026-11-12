import { createHash } from "node:crypto";

/** A SQL allow-list, not a proof of application compatibility or a PostgreSQL parser. */
export interface MigrationSafety {
  classification: "additive-safe" | "reviewed-exception" | "risky";
  reasons: string[];
}

export interface MigrationStatement {
  sql: string;
  tokens: string[];
  bodies: string[];
  reviews: string[];
}

/** Bind review to executable tokens and opaque bodies, excluding SQL comments. */
export function migrationStatementHash(statement: MigrationStatement): string {
  return createHash("sha256")
    .update(JSON.stringify([statement.tokens, statement.bodies]))
    .digest("hex");
}

/** Keep bodies and quoted values opaque; only unquoted semicolons end statements. */
export function migrationStatements(sql: string): MigrationStatement[] {
  const statements: MigrationStatement[] = [];
  let tokens: string[] = [];
  let bodies: string[] = [];
  let reviews: string[] = [];
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
      const comment = sql.slice(i + 2, end < 0 ? sql.length : end).trim();
      if (comment.startsWith("openplans-migration-allow"))
        reviews.push(tokens.length ? "misplaced annotation" : comment);
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
      bodies.push(sql.slice(i + dollar.length, end));
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
      if (tokens.length)
        statements.push({ sql: sql.slice(start, i), tokens, bodies, reviews });
      else if (reviews.length) throw new Error("Orphan migration annotation");
      tokens = [];
      bodies = [];
      reviews = [];
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
    // PostgreSQL does not fold distinct Unicode identifiers through JS case expansion.
    tokens.push(token.replace(/[a-z]/g, (letter) => letter.toUpperCase()));
    i += token.length;
  }
  if (depth !== 0) throw new Error("Unbalanced SQL parentheses");
  if (tokens.length)
    statements.push({ sql: sql.slice(start), tokens, bodies, reviews });
  else if (reviews.length) throw new Error("Orphan migration annotation");
  return statements;
}

const identifier = '(?:[A-Z_][A-Z0-9_$]*|"(?:[^"]|"")+")';
const relation = `${identifier}(?: \\. ${identifier})?`;
const builtinType =
  "(?:TEXT|BOOLEAN|BOOL|SMALLINT|INTEGER|INT|BIGINT|REAL|DOUBLE PRECISION|NUMERIC(?: \\( \\d+(?: , \\d+)? \\))?|DECIMAL(?: \\( \\d+(?: , \\d+)? \\))?|UUID|JSONB?|BYTEA|DATE|INTERVAL|TIMESTAMPTZ|TIMESTAMP(?: WITH(?:OUT)? TIME ZONE)?|VARCHAR(?: \\( \\d+ \\))?)";
const literal =
  "(?:NULL|TRUE|FALSE|[+-]? ?\\d+(?:\\.\\d+)?(?:E[+-]?\\d+)?|'(?:[^']|'')*'|INTERVAL '(?:[^']|'')*')";
const constant = new RegExp(`^${literal}(?: :: ${builtinType})?$`, "i");

function columnAddition(tokens: string[], emptyTable = false): boolean {
  let text = tokens.join(" ");
  const added = new RegExp(
    `^ADD COLUMN (?:IF NOT EXISTS )?(${identifier}) (${builtinType})(.*)$`,
  ).exec(text);
  if (!added) return false;
  text = added[3]!.trim();
  const notNull = /(?:^| )NOT NULL(?: |$)/.test(text);
  text = text.replace(/(?:^| )NOT NULL(?= |$)/, "").trim();
  if (!text) return !notNull || emptyTable;
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

export const smallTableRows = 10_000;
export const smallTableBytes = 16 * 1024 * 1024;

/** Complete public-schema inventory; missing names are absent, null sizes unknown. */
export type MigrationTableSizes = Record<
  string,
  { rows: number; bytes: number } | null
>;

function tableKey(name: string): string {
  const parts = name.match(/"(?:[^"]|"")*"|[A-Z_][A-Z0-9_$]*/gi) ?? [];
  if (parts.length === 1) parts.unshift("public");
  return parts
    .map((part) => {
      const value = part.startsWith('"')
        ? part.slice(1, -1).replaceAll('""', '"')
        : part.toLowerCase();
      return '"' + value.replaceAll('"', '""') + '"';
    })
    .join(".");
}

// Only expressions without subqueries or arbitrary function calls can seed small tables.
function boundedExpression(tokens: string[]): boolean {
  const functions = new Set([
    "CARDINALITY",
    "MD5",
    "RANDOM",
    "CLOCK_TIMESTAMP",
    "NOW",
  ]);
  const forbidden = new Set([
    "SELECT",
    "TABLE",
    "VALUES",
    "WITH",
    "FROM",
    "JOIN",
    "RETURNING",
    "OPERATOR",
    "OVER",
    "COLLATE",
    "<BODY>",
  ]);
  return tokens.every(
    (token, i) =>
      !forbidden.has(token) &&
      (!/^[A-Z_][A-Z0-9_$]*$/.test(token) ||
        tokens[i + 1] !== "(" ||
        functions.has(token) ||
        token === "IN") &&
      !(token.startsWith('"') && tokens[i + 1] === "(") &&
      !(token === "." && tokens[i + 2] === "(") &&
      (token !== "::" ||
        /^(?:TEXT|BOOLEAN|BOOL|SMALLINT|INTEGER|INT|BIGINT|REAL|NUMERIC|UUID|JSONB?|BYTEA|DATE|INTERVAL|TIMESTAMPTZ|TIMESTAMP|VARCHAR)$/.test(
          tokens[i + 1] ?? "",
        )),
  );
}

function scalarAssignment(tokens: string[]): boolean {
  if (tokens[1] !== "=") return false;
  const value = tokens.slice(2);
  if (constant.test(value.join(" "))) return true;
  if (
    value[0] !== "CASE" ||
    value.at(-1) !== "END" ||
    value.filter((t) => t === "CASE").length !== 1
  )
    return false;
  const results = value.flatMap((token, i) =>
    token === "THEN" || token === "ELSE" ? [i + 1] : [],
  );
  return (
    results.length > 0 &&
    results.every((start) => {
      let end = start;
      while (
        end < value.length &&
        !["WHEN", "ELSE", "END"].includes(value[end]!)
      )
        end++;
      return constant.test(value.slice(start, end).join(" "));
    })
  );
}

export function classifyMigration(
  sql: string,
  sizes?: MigrationTableSizes,
): MigrationSafety {
  return classifyMigrationBatch([sql], sizes)[0]!;
}

/** Carry new tables and invalidated size evidence through numeric-order pending files. */
export function classifyMigrationBatch(
  sqls: string[],
  sizes?: MigrationTableSizes,
): MigrationSafety[] {
  const tables: MigrationTableSizes = Object.fromEntries(
    Object.entries(sizes ?? {}).map(([name, size]) => [tableKey(name), size]),
  );
  const empty = new Set<string>();
  let inventoryReliable = sizes !== undefined;
  const small = (name: string) => {
    const key = tableKey(name);
    const size = tables[key];
    return (
      empty.has(key) ||
      (!!size &&
        Number.isSafeInteger(size.rows) &&
        size.rows >= 0 &&
        Number.isSafeInteger(size.bytes) &&
        size.bytes >= 0 &&
        size.rows <= smallTableRows &&
        size.bytes <= smallTableBytes)
    );
  };
  const sizeReason = (name: string) => {
    const size = tables[tableKey(name)];
    return size
      ? `${tableKey(name)}: ${size.rows < 0 ? "rows not counted" : `${size.rows} bounded rows`}, ${size.bytes} bytes; ${small(name) ? "within" : "outside"} the small-table budget`
      : `${tableKey(name)} size is unknown`;
  };
  const invalidate = (name: string) => {
    const key = tableKey(name);
    empty.delete(key);
    tables[key] = null;
  };
  const invalidateAll = () => {
    inventoryReliable = false;
    empty.clear();
    for (const key of Object.keys(tables)) tables[key] = null;
  };
  return sqls.map((sql) => {
    const reasons: string[] = [];
    let reviewed = 0;
    let statements: MigrationStatement[];
    try {
      statements = migrationStatements(sql);
    } catch {
      invalidateAll();
      return {
        classification: "risky",
        reasons: ["Malformed or unterminated SQL token/parentheses"],
      };
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

    const inspect = (
      statement: MigrationStatement,
      label: string,
      nesting = 0,
    ) => {
      const tokens = statement.tokens;
      const text = tokens.join(" ");
      let reason: string | undefined;
      const table = new RegExp(
        `^CREATE TABLE (IF NOT EXISTS )?(${relation}) \\( `,
      ).exec(text);
      const index = new RegExp(
        `^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${identifier} )?ON (?:ONLY )?(${relation}) (?:USING ${identifier} )?\\(`,
      ).exec(text);
      const alter = new RegExp(
        `^ALTER TABLE (?:ONLY )?(${relation}) (.+)$`,
      ).exec(text);
      const insert = new RegExp(`^INSERT INTO (${relation}) \\( `).exec(text);
      const update = new RegExp(`^UPDATE (${relation}) SET (.+)$`).exec(text);
      if (table && completeTableDefinition(tokens)) {
        const key = tableKey(table[2]!);
        // Conditional creation is not proof that an existing table is empty.
        if (
          !table[1] ||
          (inventoryReliable &&
            key.startsWith('"public".') &&
            !Object.hasOwn(tables, key))
        ) {
          empty.add(key);
          tables[key] = { rows: 0, bytes: 0 };
        }
      } else if (index) {
        if (!concurrentIndex(statement) && !small(index[1]!))
          reason = `Non-concurrent index blocks writes: ${sizeReason(index[1]!)}`;
        if (!empty.has(tableKey(index[1]!))) invalidate(index[1]!);
      } else if (alter) {
        const target = alter[1]!;
        const action = alter[2]!;
        let actionStart = tokens[2] === "ONLY" ? 4 : 3;
        if (tokens[actionStart] === ".") actionStart += 2;
        const actionTokens = tokens.slice(actionStart);
        const newEmptyTable = empty.has(tableKey(target));
        const allowed = additions(actionTokens).every((part) => {
          if (columnAddition(part, newEmptyTable)) return true;
          const value = part.join(" ");
          if (
            new RegExp(`^ALTER COLUMN ${identifier} DROP NOT NULL$`).test(value)
          )
            return true;
          if (
            newEmptyTable &&
            new RegExp(`^ALTER COLUMN ${identifier} SET NOT NULL$`).test(value)
          )
            return true;
          // These scans are allowed only with current small-table evidence.
          if (!small(target)) return false;
          const check = part.indexOf("CHECK");
          if (
            check > 0 &&
            part.at(-1) === ")" &&
            boundedExpression(part.slice(check + 1)) &&
            columnAddition(part.slice(0, check))
          )
            return true;
          const reference = new RegExp(
            `^(ADD COLUMN (?:IF NOT EXISTS )?${identifier} ${builtinType}) REFERENCES (${relation}) \\( ${identifier} \\)$`,
          ).exec(value);
          if (
            reference &&
            columnAddition(reference[1]!.split(" ")) &&
            small(reference[2]!)
          )
            return true;
          return (
            new RegExp(
              `^ADD CONSTRAINT ${identifier} (?:CHECK \\( .+ \\)|UNIQUE \\( ${identifier}(?: , ${identifier})* \\))$`,
            ).test(value) && boundedExpression(part.slice(5, -1))
          );
        });
        if (!allowed)
          reason = /^(?:DROP|RENAME) | TYPE | SET NOT NULL/.test(action)
            ? `Destructive or compatibility-changing ALTER TABLE ${tableKey(target)} requires review`
            : `Column/constraint action may rewrite or scan; ${sizeReason(target)}; requires a known type and non-null constant default for NOT NULL`;
      } else if (insert) {
        const target = insert[1]!;
        const values = tokens.indexOf("VALUES");
        const select = tokens.indexOf("SELECT");
        const conflict = tokens.indexOf("ON", values);
        const data = tokens.slice(
          values + 1,
          conflict < 0 ? undefined : conflict,
        );
        const columnsEnd = tokens.indexOf(")");
        const seedRows = additions(data).length;
        const seedBytes =
          Buffer.byteLength(statement.sql, "utf8") * 8 + seedRows * 1024;
        const literalValues =
          seedRows <= smallTableRows &&
          seedBytes <= smallTableBytes &&
          values === columnsEnd + 1 &&
          data[0] === "(" &&
          data.at(-1) === ")" &&
          boundedExpression(data) &&
          (conflict < 0 ||
            tokens.slice(conflict).join(" ") === "ON CONFLICT DO NOTHING");
        // INSERT SELECT can hold source locks for its whole scan. Every source must be small.
        const column = `${identifier}(?: \\. ${identifier})?`;
        const columns = `${column}(?: , ${column})*`;
        const from = `${relation}(?: ${identifier})?`;
        const comparison = `${column} = (?:${column}|${literal})`;
        const joins = `(?: JOIN ${from} ON ${comparison}(?: AND ${comparison})*)*`;
        const selectText = tokens.slice(select).join(" ");
        const sources = [
          ...selectText.matchAll(
            new RegExp(`(?:FROM|JOIN) (${relation})(?= |$)`, "g"),
          ),
        ].map((m) => m[1]!);
        const simpleSelect =
          select === columnsEnd + 1 &&
          sources.length > 0 &&
          sources.every(small) &&
          new RegExp(
            `^SELECT ${columns} FROM ${from}${joins}(?: GROUP BY ${columns})?$`,
          ).test(selectText);
        if (!small(target) || (!literalValues && !simpleSelect))
          reason = `Unbounded INSERT or source scan; ${sizeReason(target)}`;
        const scalarSeeds =
          literalValues &&
          additions(data).every(
            (row) =>
              row[0] === "(" &&
              row.at(-1) === ")" &&
              additions(row.slice(1, -1)).every((cell) =>
                constant.test(cell.join(" ")),
              ),
          );
        const previous = tables[tableKey(target)];
        invalidate(target);
        if (!reason && scalarSeeds && previous) {
          const count = additions(data).length;
          tables[tableKey(target)] = {
            rows: previous.rows + count,
            bytes:
              previous.bytes +
              Buffer.byteLength(statement.sql, "utf8") * 8 +
              count * 1024,
          };
        }
      } else if (update) {
        if (
          !small(update[1]!) ||
          !boundedExpression(tokens.slice(tokens.indexOf("SET") + 1)) ||
          !additions(tokens.slice(tokens.indexOf("SET") + 1)).every(
            scalarAssignment,
          )
        )
          reason = `UPDATE may rewrite rows or execute unknown expressions; ${sizeReason(update[1]!)}`;
        const previous = tables[tableKey(update[1]!)];
        invalidate(update[1]!);
        if (
          !reason &&
          previous &&
          additions(tokens.slice(tokens.indexOf("SET") + 1)).every(
            scalarAssignment,
          )
        )
          tables[tableKey(update[1]!)] = {
            rows: previous.rows,
            bytes:
              previous.bytes +
              (Buffer.byteLength(statement.sql, "utf8") * 8 + 1024) *
                previous.rows,
          };
      } else if (
        new RegExp(
          `^CREATE VIEW ${relation}(?: \\( ${identifier}(?: , ${identifier})* \\))? AS (?:SELECT|WITH) `,
        ).test(text) &&
        !tokens.includes("INTO")
      ) {
        // A plain view stores a query; materialization and replacement need review.
      } else if (
        new RegExp(
          `^COMMENT ON (?:TABLE|VIEW|INDEX|COLUMN|FUNCTION|TRIGGER|CONSTRAINT) .+ IS (?:NULL|'(?:[^']|'')*')$`,
        ).test(text)
      ) {
        // Catalog comments execute no query or function body.
      } else if (
        new RegExp(`^CREATE FUNCTION ${relation} \\(`).test(text) &&
        / LANGUAGE (?:SQL|PLPGSQL)(?: |$)/.test(text) &&
        tokens.some(
          (token, i) =>
            tokens[i - 1] === "AS" &&
            (token === "<BODY>" || /^(?:[eE])?'/.test(token)),
        )
      ) {
        // Definition does not execute a body. Replacement and invocation need review.
      } else if (
        new RegExp(
          `^CREATE TRIGGER ${identifier} (?:BEFORE|AFTER|INSTEAD OF) `,
        ).test(text) &&
        / EXECUTE (?:FUNCTION|PROCEDURE) /.test(text)
      ) {
        // Application compatibility still includes trigger behavior.
      } else if (
        /^DO <BODY>(?: LANGUAGE PLPGSQL)?$/.test(text) &&
        nesting < 8
      ) {
        const body = /^\s*BEGIN\s+([\s\S]*);\s*END\s*;?\s*$/i.exec(
          statement.bodies[0] ?? "",
        );
        if (!body)
          reason =
            "Opaque procedural block; control flow and dynamic SQL require review";
        else {
          try {
            const children = migrationStatements(body[1]!);
            if (children.some(concurrentIndex))
              reason = "Concurrent index cannot run inside DO";
            else {
              const firstChildReason = reasons.length;
              children.forEach((child, i) =>
                inspect(child, `${label}.${i + 1}`, nesting + 1),
              );
              const childReasons = reasons.slice(firstChildReason);
              if (
                statement.reviews.length &&
                childReasons.length &&
                childReasons.every(
                  (child) =>
                    !/Malformed|Concurrent index|annotation/.test(child),
                )
              )
                reason = reasons.splice(firstChildReason).join("; ");
            }
          } catch {
            reason = "Malformed procedural block";
          }
        }
      } else if (/^SELECT |^DO |^CALL /.test(text)) {
        reason =
          "Procedural execution may alter or backfill existing tables; function definitions alone do not prove a call safe";
      } else {
        reason =
          "Unknown or non-additive statement; possible rewrite, scan, or long lock";
      }
      if (reason) {
        const review =
          statement.reviews.length === 1 &&
          nesting === 0 &&
          !/Malformed|Concurrent index/.test(reason)
            ? /^openplans-migration-allow: ([a-f0-9]{64}) ([!-~][\x20-\x7e]{11,499})$/.exec(
                statement.reviews[0]!,
              )
            : null;
        if (review && review[1] === migrationStatementHash(statement)) {
          reviewed++;
          reasons.push(
            `Statement ${label}: Reviewed exception: ${review[2]}; ${reason}`,
          );
        } else {
          reasons.push(`Statement ${label}: ${reason}`);
          if (statement.reviews.length)
            reasons.push(
              `Statement ${label}: Invalid, misplaced, duplicate or stale allow annotation`,
            );
        }
        // Approval of an opaque operation must not let later statements reuse stale sizes.
        if (!index) invalidateAll();
      } else if (statement.reviews.length)
        reasons.push(
          `Statement ${label}: Allow annotation must target a risky top-level statement`,
        );
    };
    statements.forEach((statement, i) => inspect(statement, `${i + 1}`));
    let classification: MigrationSafety["classification"] = "additive-safe";
    if (reasons.length)
      classification =
        reviewed === reasons.length ? "reviewed-exception" : "risky";
    return {
      classification,
      reasons,
    };
  });
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
