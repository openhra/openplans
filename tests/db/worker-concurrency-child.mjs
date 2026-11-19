// Separate worker process for the disposable PostgreSQL concurrency tests.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../../dist/db/database.js";

const send = (message) => process.send(message);
let release;
const released = new Promise((resolve) => (release = resolve));
process.on("message", (message) => {
  if (message.type === "release") release();
  if (message.type === "start") void run(message);
});

async function run({ url, module, operation, pause = false, minute = 0 }) {
  const db = createDatabase(url);
  try {
    const { rows } = await db.query("SELECT pg_backend_pid() AS backend");
    send({ type: "ready", pid: process.pid, backend: rows[0].backend });
    // Only the checkpoint is intercepted. Every statement and lock runs on PostgreSQL.
    const worker = {
      ...db,
      transaction: (body) =>
        db.transaction((session) =>
          body({
            ...session,
            async query(sql, parameters, options) {
              const result = await session.query(sql, parameters, options);
              const checkpoint =
                operation === "schedule"
                  ? sql.startsWith("SELECT value->>'tick'")
                  : sql.startsWith("SELECT report FROM npi_import_run");
              if (pause && checkpoint) {
                send({ type: "holding" });
                await released;
              }
              return result;
            },
          }),
        ),
    };
    const loaded = await import(module);
    const now = () => new Date(Date.UTC(2026, 10, 11, 12, minute));
    let result;
    if (operation === "delivery") {
      result = await loaded.deliverEvents(
        worker,
        [
          {
            plugin: "@synthetic/concurrency",
            type: "cache.flushed",
            subscriber: "synthetic-shared",
            async handler() {
              send({ type: "effect" });
              if (pause) {
                send({ type: "holding" });
                await released;
              }
            },
          },
        ],
        { now, limit: 1, handlerTimeoutMs: 15_000 },
      );
    } else if (operation === "schedule") {
      result = await loaded.runScheduleTick(
        worker,
        [
          {
            plugin: "@synthetic/concurrency",
            spec: {
              name: "synthetic-concurrency",
              cron: "* * * * *",
              command: ["synthetic"],
              maxRunMs: 15_000,
            },
          },
        ],
        async () => {
          send({ type: "effect" });
          return 0;
        },
        { now },
      );
    } else {
      const root = new URL("../fixtures/nppes/", import.meta.url);
      const path = fileURLToPath(new URL("providers-v2.csv", root));
      const bytes = await readFile(path);
      const provenance = JSON.parse(
        await readFile(new URL("provenance.json", root), "utf8"),
      );
      result = await loaded.importNppes(worker, {
        kind: "full",
        state: "TX",
        path,
        url: provenance.source,
        metadata: {
          snapshot_id: "fixture",
          source: "cms-nppes",
          url: provenance.source,
          final_url: provenance.source,
          redirect_chain: [],
          status: 200,
          content_type: "text/csv",
          etag: null,
          last_modified: null,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          fetched_at: "2026-11-07T00:00:00Z",
        },
        fixture: {
          dataDate: provenance.data_date,
          input: {
            main: () => createReadStream(path),
            secondary: () =>
              createReadStream(new URL("practice-locations.csv", root)),
          },
        },
      });
    }
    send({ type: "result", result });
  } catch (error) {
    // SQL errors can include connection details or fixture fields. Send only the error class/code.
    send({ type: "failure", code: error.code ?? error.constructor.name });
  } finally {
    await db.close();
    process.disconnect();
  }
}
