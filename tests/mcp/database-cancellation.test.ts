import type * as DatabaseModule from "../../src/db/database.js";
import { readFile } from "node:fs/promises";
import { boundedDatabase } from "../../src/db/bounded.js";
import { replaceSyntax } from "../source-mutation.js";
import { importMutant, plantMutantFile } from "../mutant-file.js";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sql: [] as string[],
  released: false,
  failRollback: false,
  jsonDecodes: 0,
  cancel: undefined as (() => void) | undefined,
}));
vi.mock("pg", () => ({
  default: {
    types: {
      getTypeParser: (oid: number) => (value: string) => {
        if (oid === 114 || oid === 3802) {
          state.jsonDecodes++;
          return JSON.parse(value) as unknown;
        }
        return value;
      },
    },
    Pool: class {
      on() {}
      async connect() {
        return {
          processID: 123,
          release: () => {
            state.released = true;
          },
          query: async (
            input:
              | string
              | {
                  text: string;
                  query_timeout?: number;
                  types?: {
                    getTypeParser(oid: number): (value: string) => unknown;
                  };
                },
          ) => {
            const sql = typeof input === "string" ? input : input.text;
            if (typeof input !== "string" && input.query_timeout !== undefined)
              expect(input.query_timeout).toBe(6000);
            state.sql.push(sql);
            if (sql === "SELECT synthetic_slow()")
              await new Promise((_, reject) => {
                state.cancel = () => reject(new Error("cancelled SQL"));
              });
            if (sql === "ROLLBACK" && state.failRollback)
              throw new Error("synthetic broken connection");
            if (sql === "SELECT synthetic_json()") {
              const json = '{"synthetic":"rate evidence"}';
              const decode =
                typeof input !== "string" && input.types
                  ? input.types.getTypeParser(3802)
                  : (text: string) => {
                      state.jsonDecodes++;
                      return JSON.parse(text) as unknown;
                    };
              return {
                rows: [{ raw: decode(json) }],
                fields: [{ name: "raw", dataTypeID: 3802 }],
              };
            }
            return { rows: [] };
          },
        };
      }
      async query(sql: string, parameters: unknown[]) {
        expect(parameters).toEqual([123]);
        state.sql.push(sql);
        state.cancel?.();
        return { rows: [] };
      }
      async end() {}
    },
  },
}));
import { createDatabase } from "../../src/db/database.js";

beforeEach(() => {
  state.sql = [];
  state.jsonDecodes = 0;
  state.released = false;
  state.failRollback = false;
  state.cancel = undefined;
});
it.each([undefined, { readOnly: false }])(
  "database request scope %j applies timeout and cancellation",
  async (options) => {
    const db = createDatabase("synthetic-connection"),
      controller = new AbortController();
    const work = db.withRequest!(
      controller.signal,
      (session) => session.query("SELECT synthetic_slow()"),
      options,
    );
    while (!state.cancel) await Promise.resolve();
    expect(state.released).toBe(false);
    controller.abort();
    await expect(work).rejects.toThrow("cancelled SQL");
    expect(state.sql).toEqual([
      options?.readOnly === false ? "BEGIN" : "BEGIN READ ONLY",
      "SET LOCAL statement_timeout = '5s'",
      "SELECT synthetic_slow()",
      "SELECT pg_cancel_backend($1)",
      "ROLLBACK",
    ]);
    expect(state.released).toBe(true);
    await db.close();
  },
);
it("successful SQL commits and pre-aborted requests never acquire a client", async () => {
  const db = createDatabase("synthetic-connection"),
    controller = new AbortController();
  await db.withRequest!(controller.signal, (session) =>
    session.query("SELECT 1"),
  );
  expect(state.sql.at(-1)).toBe("COMMIT");
  controller.abort();
  const before = state.sql.length;
  await expect(
    db.withRequest!(controller.signal, (session) => session.query("SELECT 1")),
  ).rejects.toThrow();
  expect(state.sql).toHaveLength(before);
  await db.close();
});

async function opaqueJson(factory = createDatabase) {
  const db = factory("synthetic-connection");
  try {
    const signal = new AbortController().signal;
    const bounded = boundedDatabase(db, signal);
    const normal = await bounded.query("SELECT synthetic_json()");
    expect(normal.rows[0]!.raw).toEqual({ synthetic: "rate evidence" });
    const decodes = state.jsonDecodes;
    const wire = await bounded.query("SELECT synthetic_json()", [], {
      jsonAsText: true,
    });
    expect(wire.rows[0]!.raw, "JSON must stay text on the parent").toBe(
      '{"synthetic":"rate evidence"}',
    );
    expect(wire.jsonColumns).toEqual(["raw"]);
    expect(state.jsonDecodes, "parent must not decode worker JSON").toBe(
      decodes,
    );
  } finally {
    await db.close();
  }
}
it("preserves JSON text and its column types through a bounded request", async () =>
  opaqueJson());
it("rejects decoding worker JSON in the parent", async () => {
  const source = new URL("../../src/db/database.ts", import.meta.url);
  const mutant = await plantMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "options?.jsonAsText",
      "false",
    ),
  );
  try {
    const changed = await importMutant<typeof DatabaseModule>(
      mutant.url,
      "createDatabase",
    );
    await expect(opaqueJson(changed.createDatabase)).rejects.toThrow(
      "JSON must stay text on the parent",
    );
  } finally {
    await mutant.cleanup();
  }
});
