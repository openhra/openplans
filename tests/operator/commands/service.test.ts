import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import type {
  Database,
  OperatorCommandScope,
  SqlSession,
  PassThroughSource,
  Question,
} from "@openplans/plugin-sdk";
import {
  createOperatorCommandClient,
  canonicalCommandJson,
} from "../../../src/operator/commands/service.js";
import { passThroughWriter } from "../../../src/plugins/sources/scoped-writer.js";
import { syntheticSource } from "../../fixtures/plugins/synthetic-passthrough/index.mjs";
import { migratedTemplate } from "../../pglite.js";
import {
  authority,
  command,
  envelope,
  register,
  setup,
  SOURCE,
  unchanged,
} from "./fixture.js";

let template: Awaited<ReturnType<typeof migratedTemplate>>;
let db: Database;
beforeAll(async () => {
  template = await migratedTemplate();
});
afterAll(async () => {
  await template?.close();
});
beforeEach(async () => {
  db = await template.fresh();
  await setup(db);
});
afterEach(async () => {
  await db?.close();
});
const client = (
  spec = command(),
  writable = () => true,
  actor: "worker" | "shared_operator" = "worker",
) =>
  createOperatorCommandClient(
    { db, commands: register(spec).operatorCommands, writable },
    authority(actor),
  );

it("commits a strict result, host actor, audit and durable result atomically", async () => {
  expect(await client().execute(envelope())).toEqual({ allowed: true });
  const snapshot = await unchanged(db);
  expect(snapshot.state).toEqual([{ value: true }]);
  expect(snapshot.audit).toHaveLength(1);
  const entry = snapshot.audit[0]!.entry as Record<string, unknown>;
  expect(entry.actor).toEqual({ class: "worker" });
  expect(entry.source_id).toBe(SOURCE);
  expect(entry.input_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(entry).sort()).toEqual(
    [
      "action",
      "outcome",
      "actor",
      "at",
      "source_id",
      "expected",
      "input_hash",
      "before_hash",
      "after_hash",
      "reason_code",
      "idempotency_key",
    ].sort(),
  );
  expect(snapshot.results).toHaveLength(1);
});
it("worker and API clients use the same canonical input hash and output", async () => {
  const api = await client(command(), () => true, "shared_operator").execute(
    envelope(),
  );
  const saved = await unchanged(db);
  const worker = await client().execute(envelope());
  expect(canonicalCommandJson(worker)).toBe(canonicalCommandJson(api));
  expect(await unchanged(db)).toEqual(saved);
});
it("retries survive a new client and changed payload, expected version or receipt cannot reuse a key", async () => {
  await client().execute(envelope());
  const before = await unchanged(db);
  for (const changed of [
    { payload: { allowed: false } },
    { expected: { draft: null, version: 1, activation: 1 } },
    { preview_receipt: "changed" },
  ])
    await expect(client().execute(envelope(changed))).rejects.toThrow(
      "operator_command_idempotency_conflict",
    );
  expect(await unchanged(db)).toEqual(before);
});
it("rejects stale versions before mutation", async () => {
  const before = await unchanged(db);
  await expect(
    client().execute(
      envelope({ expected: { draft: "stale", version: null, activation: 0 } }),
    ),
  ).rejects.toThrow("operator_command_version_conflict");
  expect(await unchanged(db)).toEqual(before);
});
it("rejects client actor and grants, string coercion and excessive input without effects", async () => {
  const before = await unchanged(db);
  for (const request of [
    { ...envelope(), actor: { class: "worker" } },
    { ...envelope(), grants: [SOURCE] },
    envelope({ payload: { allowed: "true" } }),
    envelope({ payload: { allowed: true, note: "x".repeat(65_536) } }),
  ])
    await expect(client().execute(request)).rejects.toThrow(
      "operator_command_invalid_input",
    );
  expect(await unchanged(db)).toEqual(before);
});
it("enforces source grants and exact permission, including retries", async () => {
  await client().execute(envelope());
  const before = await unchanged(db);
  for (const grants of [
    [],
    [{ source: "other", permissions: ["edit"] as const }],
    [{ source: SOURCE, permissions: ["publish"] as const }],
  ]) {
    const bound = createOperatorCommandClient(
      { db, commands: register().operatorCommands, writable: () => true },
      { ...authority(), grants },
    );
    await expect(bound.execute(envelope())).rejects.toThrow(
      "operator_command_forbidden",
    );
  }
  await expect(
    client().execute(envelope({ source_id: "other" })),
  ).rejects.toThrow("operator_command_forbidden");
  expect(await unchanged(db)).toEqual(before);
});
it("read-only mode applies before execution, on retries and at the commit fence", async () => {
  await expect(
    client(command(), () => false).execute(envelope()),
  ).rejects.toThrow("operator_command_read_only");
  let writable = true;
  const before = await unchanged(db);
  await expect(
    client(
      command({
        run: async () => {
          writable = false;
        },
      }),
      () => writable,
    ).execute(envelope()),
  ).rejects.toThrow("operator_command_read_only");
  expect(await unchanged(db)).toEqual(before);
});
for (const fail of ["run", "audit", "remember"])
  it(`rolls back changes, owner audit, result and outbox on ${fail} failure`, async () => {
    const before = await unchanged(db);
    await expect(
      client(command({ fail, publication: true })).execute(envelope()),
    ).rejects.toThrow("operator_command_failed");
    expect(await unchanged(db)).toEqual(before);
  });
it("requires a durable outbox and rolls back when its insert fails", async () => {
  await db.exec(
    "ALTER TABLE plugin_event_outbox ADD CONSTRAINT synthetic_outbox_failure CHECK(event_type <> 'msot.changed')",
  );
  const before = await unchanged(db);
  await expect(
    client(command({ publication: true })).execute(envelope()),
  ).rejects.toThrow("operator_command_failed");
  expect(await unchanged(db)).toEqual(before);
});
it("commits publication with one outbox row and never duplicates it on retry", async () => {
  await client(command({ publication: true })).execute(envelope());
  const before = await unchanged(db);
  expect(before.outbox).toHaveLength(1);
  await client(command({ publication: true })).execute(envelope());
  expect(await unchanged(db)).toEqual(before);
});
it("requires a publication event rather than accepting a successful unaudited notification", async () => {
  const spec = {
    ...command(),
    publication: true,
    permission: "publish" as const,
  };
  const before = await unchanged(db);
  await expect(client(spec).execute(envelope())).rejects.toThrow(
    "operator_command_outbox_required",
  );
  expect(await unchanged(db)).toEqual(before);
});
it("closes the scoped transaction after use and cancels without partial state", async () => {
  let captured: OperatorCommandScope | undefined;
  await client(
    command({
      run: async (scope) => {
        captured = scope;
      },
    }),
  ).execute(envelope());
  await expect(
    captured!.db.exec("DELETE FROM plg_msot_command_state"),
  ).rejects.toThrow("operator_command_deadline");
  const controller = new AbortController();
  const before = await unchanged(db);
  const bound = createOperatorCommandClient(
    {
      db,
      commands: register(
        command({
          run: async () => {
            controller.abort();
          },
        }),
      ).operatorCommands,
      writable: () => true,
    },
    { ...authority(), signal: controller.signal },
  );
  await expect(
    bound.execute(envelope({ idempotency_key: "cancelled" })),
  ).rejects.toThrow("operator_command_deadline");
  expect(await unchanged(db)).toEqual(before);
});
it("cannot substitute the pass-through writer for a transaction root", async () => {
  const substituted = passThroughWriter(
    [syntheticSource() as PassThroughSource<Question, unknown>],
    db,
    db,
  )!;
  const bound = createOperatorCommandClient(
    {
      db: substituted,
      commands: register().operatorCommands,
      writable: () => true,
    },
    authority(),
  );
  await expect(bound.execute(envelope())).rejects.toThrow(
    "operator_command_transaction_required",
  );
});
it("rejects SQL escaping the owner tables, DDL, session control or side-effect functions", async () => {
  const before = await unchanged(db);
  for (const sql of [
    "DELETE FROM plugin_event_outbox",
    "UPDATE plg_other_state SET value=true",
    "CREATE TABLE escaped(id int)",
    "COMMIT",
    "SELECT set_config('role','owner',true)",
    "SELECT public.side_effect()",
    "UPDATE plg_msot_command_state SET value=true; DELETE FROM plugin_event_outbox",
  ]) {
    const spec = command({
      run: async ({ db: scoped }) => {
        await scoped.exec(sql);
      },
    });
    await expect(client(spec).execute(envelope())).rejects.toThrow(
      "operator_command_sql_scope",
    );
    expect(await unchanged(db)).toEqual(before);
  }
});
it("cannot catch a scope refusal and commit an earlier write", async () => {
  const before = await unchanged(db);
  const spec = command({
    run: async ({ db: scoped }) => {
      try {
        await scoped.exec("DELETE FROM plugin_event_outbox");
      } catch {
        /* Deliberately swallow a denied fixture statement. */
      }
    },
  });
  await expect(client(spec).execute(envelope())).rejects.toThrow(
    "operator_command_sql_scope",
  );
  expect(await unchanged(db)).toEqual(before);
});
it("refuses invalid output and unsafe exception text without committing", async () => {
  const original = command();
  const spec = {
    ...original,
    run: async (...args: Parameters<typeof original.run>) => ({
      ...(await original.run(...args)),
      output: { allowed: true, private_note: "synthetic-private-marker" },
    }),
  };
  const before = await unchanged(db);
  await expect(client(spec).execute(envelope())).rejects.toThrow(
    "operator_command_invalid_output",
  );
  expect(await unchanged(db)).toEqual(before);
});
it("aborts a stalled owner callback at its deadline and rolls back", async () => {
  const before = await unchanged(db);
  const spec = {
    ...command({ run: async () => new Promise<void>(() => {}) }),
    timeoutMs: 20,
  };
  await expect(client(spec).execute(envelope())).rejects.toThrow(
    "operator_command_deadline",
  );
  expect(await unchanged(db)).toEqual(before);
});
it("uses one writable request transaction on a host with cancellation support", async () => {
  let transactions = 0;
  const root = {
    ...db,
    withRequest: async <T>(
      signal: AbortSignal,
      run: (session: SqlSession) => Promise<T>,
      options?: { readOnly?: boolean },
    ) => {
      expect(signal.aborted).toBe(false);
      expect(options?.readOnly).toBe(false);
      transactions++;
      return db.transaction((session) => run(session));
    },
  };
  await createOperatorCommandClient(
    { db: root, commands: register().operatorCommands, writable: () => true },
    authority(),
  ).execute(envelope());
  expect(transactions).toBe(1);
  expect((await unchanged(db)).state).toEqual([{ value: true }]);
});
it("authorizes durable result lookup in read-only mode without replaying a change", async () => {
  const lookup = {
    command: envelope().command,
    source_id: SOURCE,
    idempotency_key: envelope().idempotency_key,
  };
  expect(await client(command(), () => false).result(lookup)).toBeNull();
  await client().execute(envelope());
  const before = await unchanged(db);
  expect(await client(command(), () => false).result(lookup)).toEqual({
    allowed: true,
  });
  expect(await unchanged(db)).toEqual(before);
  const forbidden = createOperatorCommandClient(
    { db, commands: register().operatorCommands, writable: () => false },
    { ...authority(), grants: [] },
  );
  await expect(forbidden.result(lookup)).rejects.toThrow(
    "operator_command_forbidden",
  );
});
it("result lookup cannot use its storage hook as a writer", async () => {
  const spec = command();
  const originalLookup = spec.store.lookup;
  const forbidden = {
    ...spec,
    store: {
      ...spec.store,
      lookup: async (...args: Parameters<typeof originalLookup>) => {
        await args[1].db.exec("DELETE FROM plg_msot_command_state");
        return originalLookup(...args);
      },
    },
  };
  const before = await unchanged(db);
  await expect(
    client(forbidden).result({
      command: envelope().command,
      source_id: SOURCE,
      idempotency_key: "absent",
    }),
  ).rejects.toThrow("operator_command_sql_scope");
  expect(await unchanged(db)).toEqual(before);
});
