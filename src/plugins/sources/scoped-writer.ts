import { readdirSync, readFileSync } from "node:fs";
import type {
  PassThroughSource,
  Question,
  SqlSession,
} from "@openplans/plugin-sdk";
import { migrationsDirectory } from "../../db/migrate.js";

type Source = PassThroughSource<Question, unknown>;

/**
 * The write handle a plugin route gets for its own pass-through sources (design 5.10.3). It is
 * never a general writer:
 * - statements that write nothing run read-only;
 * - a statement that writes may name only the plugin's own storage tables (`storage.tables`, else
 *   `storage.excludedTables`), never a table the core's migrations create;
 * - DDL, transaction control, session settings, several statements in one string and functions
 *   with side effects are refused.
 * Anything else throws `PassThroughWriteRefused`. When the plugin hands the handle to
 * `ctx.sources.passThrough.apply`, the core runs its own statements (attempts, budget row,
 * generic stored answers and receipts) for the plugin's sources only; other sources see a
 * read-only scope.
 */
export class PassThroughWriteRefused extends Error {
  readonly code = "passthrough_write_refused";
  constructor() {
    super("passthrough_write_refused");
    this.name = "PassThroughWriteRefused";
  }
}

interface Grant {
  /** The plugin's own pass-through sources, by identity: an id alone could name another's. */
  readonly sources: ReadonlySet<Source>;
  readonly reader: SqlSession;
  readonly writer: SqlSession;
  /** One session per source, so a source's hooks write only its own tables. */
  readonly perSource: Map<Source, SqlSession>;
}
const grants = new WeakMap<SqlSession, Grant>();
/** Guarded per-source sessions and the writer the core runs its own statements on. */
const coreWriters = new WeakMap<SqlSession, SqlSession>();

let coreTableNames: ReadonlySet<string> | undefined;
/** Tables the core's migrations create. A plugin can never claim one as its own. */
export function coreTables(): ReadonlySet<string> {
  if (coreTableNames) return coreTableNames;
  const names = new Set<string>();
  const create =
    /create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  for (const file of readdirSync(migrationsDirectory))
    if (file.endsWith(".sql"))
      for (const match of readFileSync(
        `${migrationsDirectory}${file}`,
        "utf8",
      ).matchAll(create))
        names.add(match[1]!.toLowerCase());
  coreTableNames = names;
  return names;
}

/** The tables a source's own storage hooks may write; core tables are never among them. */
export function ownTables(source: Source): string[] {
  const storage = source.storage;
  if (!storage) return [];
  const core = coreTables();
  const declared = storage.tables ?? storage.excludedTables;
  return [...new Set(declared.map((name) => name.toLowerCase()))].filter(
    (name) => /^[a-z_][a-z0-9_]*$/.test(name) && !core.has(name),
  );
}

// A statement must start with one of these; DDL, transaction control and session settings
// never do, and a data-modifying CTE can only hold the writes `writeTargets` reads.
const STATEMENT_STARTS = [
  "select",
  "with",
  "insert",
  "update",
  "delete",
  "values",
  "table",
];
// Functions with side effects, refused wherever they are called; MERGE inside a CTE too.
const DENIED_FUNCTIONS = new Set(["set_config", "setval", "nextval"]);
const DENIED_PREFIXES = ["pg_", "lo_", "dblink"];

interface Token {
  text: string;
  word: boolean;
  quoted: boolean;
}

/** Words, quoted identifiers and punctuation, with comments and string literals dropped. */
function tokens(sql: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(ch)) i++;
    else if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
    } else if (ch === "'" || ((ch === "E" || ch === "e") && next === "'")) {
      const escapes = ch !== "'";
      i += escapes ? 2 : 1;
      for (;;) {
        if (i >= sql.length) return null;
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out.push({ text: "''", word: false, quoted: false });
    } else if (ch === "$" && /^\$([a-z_][a-z0-9_]*)?\$/i.test(sql.slice(i))) {
      const tag = /^\$([a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) return null;
      i = end + tag.length;
      out.push({ text: "''", word: false, quoted: false });
    } else if (ch === '"') {
      let name = "";
      i++;
      for (;;) {
        if (i >= sql.length) return null;
        if (sql[i] === '"' && sql[i + 1] === '"') {
          name += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else name += sql[i++];
      }
      out.push({ text: name, word: true, quoted: true });
    } else if (/[a-z_]/i.test(ch)) {
      const word = /^[a-z_][a-z0-9_$]*/i.exec(sql.slice(i))![0];
      i += word.length;
      out.push({ text: word.toLowerCase(), word: true, quoted: false });
    } else {
      out.push({ text: ch, word: false, quoted: false });
      i++;
    }
  }
  return out;
}

/**
 * The tables a statement writes: an empty list for a statement that writes nothing, null for a
 * statement the scoped writer refuses outright.
 */
export function writeTargets(sql: string): string[] | null {
  const list = tokens(sql);
  if (!list || !list.length) return null;
  // One statement only: nothing may follow a semicolon.
  const semicolon = list.findIndex((t) => t.text === ";" && !t.word);
  if (semicolon >= 0 && semicolon < list.length - 1) return null;
  const first = list[0]!;
  if (!first.word || first.quoted) return null;
  if (!STATEMENT_STARTS.includes(first.text)) return null;
  const targets: string[] = [];
  const at = (index: number) => list[index];
  const name = (index: number): [string | null, number] => {
    let j = index;
    if (at(j)?.text === "only" && !at(j)!.quoted) j++;
    const head = at(j);
    if (!head?.word) return [null, j];
    if (at(j + 1)?.text === ".") {
      const tail = at(j + 2);
      if (!tail?.word || head.text !== "public") return [null, j];
      return [tail.text, j + 2];
    }
    return [head.text, j];
  };
  for (let i = 0; i < list.length; i++) {
    const token = list[i]!;
    if (!token.word || token.quoted) continue;
    if (token.text === "merge") return null;
    const called = list[i + 1]?.text === "(";
    if (
      called &&
      (DENIED_FUNCTIONS.has(token.text) ||
        DENIED_PREFIXES.some((prefix) => token.text.startsWith(prefix)))
    )
      return null;
    if (token.text === "into") {
      // INSERT INTO is a write target; SELECT ... INTO creates a table.
      if (list[i - 1]?.text !== "insert") return null;
      const [target] = name(i + 1);
      if (!target) return null;
      targets.push(target);
    } else if (token.text === "update") {
      const before = list[i - 1]?.text;
      // ON CONFLICT ... DO UPDATE writes the INSERT's own table; FOR UPDATE only locks.
      if (before === "do" || before === "for" || before === "key") continue;
      const [target] = name(i + 1);
      if (!target) return null;
      targets.push(target);
    } else if (token.text === "delete") {
      if (list[i + 1]?.text !== "from") return null;
      const [target] = name(i + 2);
      if (!target) return null;
      targets.push(target);
    }
  }
  return targets;
}

/** A session that runs statements writing nothing read-only and writes only to `tables`. */
function guarded(
  reader: SqlSession,
  writer: SqlSession,
  tables: ReadonlySet<string>,
): SqlSession {
  const session: SqlSession = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      const targets = writeTargets(sql);
      if (targets === null) throw new PassThroughWriteRefused();
      if (!targets.length) return reader.query<Row>(sql, parameters);
      if (!targets.every((table) => tables.has(table)))
        throw new PassThroughWriteRefused();
      return writer.query<Row>(sql, parameters);
    },
    async exec(sql: string) {
      await session.query(sql);
    },
  };
  return Object.freeze(session);
}

/**
 * The write handle for one plugin route request, or undefined when the plugin registered no
 * pass-through source. `reader` must be read-only; `writer` is the host's request writer.
 */
export function passThroughWriter(
  sources: readonly Source[],
  reader: SqlSession,
  writer: SqlSession,
): SqlSession | undefined {
  if (!sources.length) return undefined;
  const own = new Set(sources.flatMap(ownTables));
  const handle = guarded(reader, writer, own);
  grants.set(handle, {
    sources: new Set(sources),
    reader,
    writer,
    perSource: new Map(),
  });
  return handle;
}

/**
 * The writer a source sees for a scope's writer. A host writer stays as it is. For a plugin's
 * handle: the source's own guarded session when the source belongs to that plugin, else none
 * (the source runs read-only).
 */
export function sourceWriter(
  writer: SqlSession | undefined,
  source: Source,
): SqlSession | undefined {
  const grant = writer && grants.get(writer);
  if (!grant) return writer;
  if (!grant.sources.has(source)) return undefined;
  let session = grant.perSource.get(source);
  if (!session) {
    session = guarded(grant.reader, grant.writer, new Set(ownTables(source)));
    coreWriters.set(session, grant.writer);
    grant.perSource.set(source, session);
  }
  return session;
}

/** The session the core runs its own pass-through statements on. */
export function coreWriter(db: SqlSession): SqlSession {
  return coreWriters.get(db) ?? db;
}
