import { lowestInventory } from "../../src/worker/lowest-prebuild.js";
import { withDataPolicy } from "../../src/services/data-window.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { setup } from "../compat/v1/helpers.js";
import { runWorker } from "../../src/worker/commands.js";
import { lowestInput } from "../../src/api/handy.js";
import { buildLowestCounty } from "../../src/worker/handy-build.js";
import {
  renewLowestPremiums,
  runLowestRenew,
} from "../../src/worker/lowest-renew.js";
import {
  handyManifest,
  readLowestCell,
} from "../../src/db/handy-repository.js";
import type * as Repository from "../../src/db/handy-repository.js";
import type { Database, SqlSession } from "../../src/db/database.js";
import { lowestPremiums } from "../../src/services/handy.js";
import { withMutantFile, importMutant } from "../mutant-file.js";

let h: Awaited<ReturnType<typeof setup>>;
const input = lowestInput({ county: "48201", year: 2026, age: 40 });
const other = lowestInput({ county: "48453", year: 2026, age: 40 });
const admitted = () => true;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.db.exec(
    "DELETE FROM handy_lowest_active; DELETE FROM handy_lowest_build; DELETE FROM handy_lowest_evidence; DELETE FROM plugin_state WHERE key='core:lowest-renewal'",
  );
});
async function due(hours = 1) {
  await h.db.query(
    "UPDATE handy_lowest_build SET expires_at=now()+($1::double precision * interval '1 hour')",
    [hours],
  );
}
async function state() {
  return (
    await h.db.query<{
      value: { after: string; status: string; last_failure?: unknown };
    }>("SELECT value FROM plugin_state WHERE key='core:lowest-renewal'")
  ).rows[0]!.value;
}

it("renews expired and soon-expiring cells but leaves a fresh cell unchanged", async () => {
  await buildLowestCounty(h.db, [input, { ...input, age: 41 }]);
  const fresh = await renewLowestPremiums(h.db, { admitted });
  expect(fresh).toMatchObject({ status: "complete", built_cells: 0 });
  for (const hours of [-1, 1]) {
    await due(hours);
    expect(await renewLowestPremiums(h.db, { admitted })).toMatchObject({
      status: "complete",
      groups: 1,
      built_cells: 2,
    });
    expect(
      await readLowestCell(h.db, input, await handyManifest(h.db)),
    ).toBeDefined();
  }
});

it("renews a group before its shared evidence expires", async () => {
  await buildLowestCounty(h.db, [input]);
  await h.db.query(
    "UPDATE handy_lowest_evidence SET expired_at=now()+interval '1 hour'",
  );
  expect(await renewLowestPremiums(h.db, { admitted })).toMatchObject({
    status: "complete",
    built_cells: 1,
  });
  expect(
    (await h.db.query("SELECT expired_at FROM handy_lowest_evidence")).rows[0]!
      .expired_at,
  ).toBeNull();
});

it("resumes after a bounded group and wraps its durable cursor", async () => {
  await buildLowestCounty(h.db, [input]);
  await buildLowestCounty(h.db, [other]);
  await due();
  expect(
    await renewLowestPremiums(h.db, { admitted, maxGroups: 1 }),
  ).toMatchObject({ status: "bounded", groups: 1, built_cells: 1 });
  expect((await state()).after).toBe("2026:48201");
  expect(
    await renewLowestPremiums(h.db, { admitted, maxGroups: 1 }),
  ).toMatchObject({ status: "complete", groups: 1, built_cells: 1 });
  expect((await state()).after).toBe("");
});

it("rolls back a failed replacement, serves the old valid cell, then refuses after expiry without pricing reads", async () => {
  await buildLowestCounty(h.db, [input]);
  await due();
  const old = await h.db.query("SELECT build_id FROM handy_lowest_build");
  const broken: Database = {
    ...h.db,
    transaction: (run) =>
      h.db.transaction((tx) =>
        run({
          ...tx,
          async query(sql, values) {
            if (sql.includes("INSERT INTO handy_lowest_build"))
              throw new Error("synthetic publication failure");
            return tx.query(sql, values);
          },
        }),
      ),
  };
  expect(await renewLowestPremiums(broken, { admitted })).toMatchObject({
    status: "failed",
    last_failure: { group: "2026:48201", code: "renewal_failed" },
  });
  expect((await state()).last_failure).toMatchObject({
    code: "renewal_failed",
  });
  expect(
    (await h.db.query("SELECT build_id FROM handy_lowest_build")).rows,
  ).toEqual(old.rows);
  const guarded: SqlSession = {
    ...h.db,
    async query(sql, values) {
      if (
        /(?:FROM|JOIN)\s+(?:rate|plan|plan_attribute|state_community_rate)\b/i.test(
          sql,
        )
      )
        throw new Error("Request computed a cell");
      return h.db.query(sql, values);
    },
  };
  expect(
    (await lowestPremiums(guarded, input, { builtOnly: true })).status,
  ).toBe("calculated");
  await due(-1);
  await expect(
    lowestPremiums(guarded, input, { builtOnly: true }),
  ).rejects.toMatchObject({ error: { code: "lowest_not_built" } });
  // The failure remains visible even when a later sweep completes.
  await renewLowestPremiums(h.db, { admitted });
  expect((await state()).last_failure).toMatchObject({
    code: "renewal_failed",
  });
});

it("stops before a transaction when admission closes, then resumes on the next run", async () => {
  await buildLowestCounty(h.db, [input]);
  await buildLowestCounty(h.db, [other]);
  await due();
  let calls = 0;
  expect(
    await renewLowestPremiums(h.db, { admitted: () => ++calls <= 2 }),
  ).toMatchObject({ status: "deferred", groups: 1 });
  expect((await state()).after).toBe("2026:48201");
  expect(await renewLowestPremiums(h.db, { admitted })).toMatchObject({
    status: "complete",
    groups: 1,
  });
  expect(
    await renewLowestPremiums(h.db, { admitted: () => false }),
  ).toMatchObject({ status: "deferred", groups: 0 });
  const controller = new AbortController();
  controller.abort();
  expect(
    await renewLowestPremiums(h.db, { admitted, signal: controller.signal }),
  ).toMatchObject({ status: "deferred", groups: 0 });
});

it("stops at the elapsed-time bound and rejects unbounded options", async () => {
  await buildLowestCounty(h.db, [input]);
  await due();
  let time = 0;
  expect(
    await renewLowestPremiums(h.db, {
      admitted,
      maxRunMs: 1,
      now: () => time++,
    }),
  ).toMatchObject({ status: "deferred", groups: 0 });
  await expect(renewLowestPremiums(h.db, { maxGroups: 1001 })).rejects.toThrow(
    "Invalid renewal bounds",
  );
});

it("keeps the command disabled without opening a database and rejects malformed bounds", async () => {
  const open = () => {
    throw new Error("must remain unopened");
  };
  const lines: string[] = [];
  const output = {
    out: (s: string) => lines.push(s),
    error: (s: string) => lines.push(s),
  };
  expect(
    await runWorker(["prebuild", "lowest-premiums", "--renew"], open, output),
  ).toBe(0);
  expect(JSON.parse(lines[0]!)).toMatchObject({ status: "disabled" });
  expect(await runLowestRenew(["--max-groups", "1001"], open, output)).toBe(1);
});

it("drops a leaving cache year from renewal at rollover without writing replacements", async () => {
  await buildLowestCounty(h.db, [input]);
  await due();
  const before = (
    await h.db.query(
      "SELECT build_id FROM handy_lowest_build ORDER BY build_id",
    )
  ).rows;
  const result = await withDataPolicy(
    { historyYears: 3 },
    () => renewLowestPremiums(h.db, { admitted }),
    new Date("2028-01-01Z"),
  );
  expect(result).toMatchObject({
    status: "complete",
    groups: 0,
    built_cells: 0,
  });
  expect(
    (
      await h.db.query(
        "SELECT build_id FROM handy_lowest_build ORDER BY build_id",
      )
    ).rows,
  ).toEqual(before);
});

it("a planted expiry-check bypass fails the persisted-cell refusal assertion", async () => {
  await buildLowestCounty(h.db, [input]);
  await due(-1);
  const manifest = await handyManifest(h.db);
  const assertExpired = async (read: typeof readLowestCell) =>
    expect(await read(h.db, input, manifest)).toBeUndefined();
  await assertExpired(readLowestCell);
  const source = new URL("../../src/db/handy-repository.ts", import.meta.url);
  await withMutantFile(
    source,
    (await readFile(source, "utf8")).replace(
      "AND b.expires_at>now() AND (b.expired_at IS NULL OR b.expired_at>now())",
      "AND true AND (b.expired_at IS NULL OR b.expired_at>now())",
    ),
    async (file) => {
      const mutant = await importMutant<typeof Repository>(
        file,
        "readLowestCell",
      );
      await expect(assertExpired(mutant.readLowestCell)).rejects.toThrow();
    },
  );
});

it("returns a failing command exit and closes its database when renewal fails", async () => {
  vi.stubEnv("OPENPLANS_LOWEST_PREMIUMS", "on");
  let closed = false;
  const failing: Database = {
    ...h.db,
    withSession: async () => {
      throw new Error("synthetic connection failure");
    },
    close: async () => {
      closed = true;
    },
  };
  const messages: string[] = [];
  try {
    expect(
      await runLowestRenew([], () => failing, {
        out: (message) => messages.push(message),
        error: (message) => messages.push(message),
      }),
    ).toBe(1);
    expect(closed).toBe(true);
    expect(messages.join(" ")).toContain("Lowest renewal failed");
    expect(messages.join(" ")).not.toContain("synthetic connection failure");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("resolves one annual policy for an explicit cache inventory", async () => {
  let policyReads = 0;
  const observed: Database = {
    ...h.db,
    async query(sql, values, options) {
      if (sql.includes("FROM annual_data_admission")) policyReads++;
      return h.db.query(sql, values, options);
    },
  };
  const inventory = Array.from({ length: 20 }, (_, age) => ({
    county: "48201",
    year: 2026,
    age,
  }));
  const cells = [];
  for await (const cell of lowestInventory(observed, { inventory }))
    cells.push(cell);
  expect(cells).toHaveLength(inventory.length);
  expect(policyReads).toBe(1);
});
