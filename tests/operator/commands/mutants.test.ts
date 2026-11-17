import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import type { Database } from "@openplans/plugin-sdk";
import * as service from "../../../src/operator/commands/service.js";
import * as scoped from "../../../src/operator/commands/scope.js";
import { plantMutant } from "../../../src/plugins/testing/artifacts.js";
import { responseDigest } from "../../plugins/admin-support/digests.js";
import { migratedTemplate } from "../../pglite.js";
import {
  authority,
  command,
  envelope,
  register,
  setup,
  tables,
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

it("the rollback assertion rejects an audit-bypass mutant in a disposable service copy", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/operator/commands/service.ts", import.meta.url),
    "spec.store.audit",
    "(async () => {})",
  );
  try {
    const broken = (await import(mutant.path)) as typeof service;
    const options = {
      db,
      commands: register(command({ fail: "audit" })).operatorCommands,
      writable: () => true,
    };
    const before = await unchanged(db);
    await expect(
      service
        .createOperatorCommandClient(options, authority())
        .execute(envelope()),
    ).rejects.toThrow("operator_command_failed");
    expect(await unchanged(db)).toEqual(before);
    await broken
      .createOperatorCommandClient(options, authority())
      .execute(envelope());
    const after = await unchanged(db);
    expect(() => expect(after).toEqual(before)).toThrow();
  } finally {
    await mutant.cleanup();
  }
});
it("the SQL scope assertion rejects a prefix-bypass mutant", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/operator/commands/scope.ts", import.meta.url),
    'if (!commandSqlAllowed(sql, allowed)) return refuse("operator_command_sql_scope");',
    "",
  );
  try {
    const broken = (await import(mutant.path)) as typeof scoped;
    const check = async (factory: typeof scoped.commandSession) => {
      try {
        await db.transaction(async (tx) => {
          const session = factory(
            tx,
            [tables[1]!],
            new AbortController().signal,
          );
          try {
            await session.db.exec(
              "UPDATE plg_msot_command_state SET value=true",
            );
          } finally {
            session.close();
          }
        });
        return false;
      } catch {
        return true;
      }
    };
    expect(await check(scoped.commandSession)).toBe(true);
    const accepted = await check(broken.commandSession);
    expect(() => expect(accepted).toBe(true)).toThrow();
  } finally {
    await mutant.cleanup();
  }
});
it("the idempotency assertion rejects a changed-payload bypass mutant", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/operator/commands/service.ts", import.meta.url),
    'if (previous.input_hash !== inputHash) return refuse("operator_command_idempotency_conflict");',
    "",
  );
  try {
    const broken = (await import(mutant.path)) as typeof service;
    const options = {
      db,
      commands: register().operatorCommands,
      writable: () => true,
    };
    await service
      .createOperatorCommandClient(options, authority())
      .execute(envelope());
    const changed = envelope({ payload: { allowed: false } });
    await expect(
      service
        .createOperatorCommandClient(options, authority())
        .execute(changed),
    ).rejects.toThrow("operator_command_idempotency_conflict");
    const accepted = await broken
      .createOperatorCommandClient(options, authority())
      .execute(changed);
    expect(() => expect(accepted).toBeUndefined()).toThrow();
  } finally {
    await mutant.cleanup();
  }
});
it("the strict envelope assertion rejects an actor-field acceptance mutant", async () => {
  const mutant = await plantMutant(
    new URL("../../../src/operator/commands/service.ts", import.meta.url),
    "operatorCommandEnvelopeSchema.safeParse",
    "operatorCommandEnvelopeSchema.passthrough().safeParse",
  );
  try {
    const broken = (await import(mutant.path)) as typeof service;
    const options = {
      db,
      commands: register().operatorCommands,
      writable: () => true,
    };
    const forged = { ...envelope(), actor: { class: "worker" } };
    await expect(
      service
        .createOperatorCommandClient(options, authority("shared_operator"))
        .execute(forged),
    ).rejects.toThrow("operator_command_invalid_input");
    const result = await broken
      .createOperatorCommandClient(options, authority("shared_operator"))
      .execute(forged);
    expect(() => expect(result).toBeUndefined()).toThrow();
  } finally {
    await mutant.cleanup();
  }
});
it("rejects one-byte body and stable-header mutants through the common digest helper", async () => {
  const digest = await responseDigest(
    new Response("synthetic-a", { headers: { "cache-control": "no-store" } }),
  );
  for (const response of [
    new Response("synthetic-b", { headers: { "cache-control": "no-store" } }),
    new Response("synthetic-a", { headers: { "cache-control": "no-storf" } }),
  ]) {
    const mutant = await responseDigest(response);
    expect(() => expect(mutant).toEqual(digest)).toThrow();
  }
});
