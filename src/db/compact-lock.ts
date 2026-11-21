import type { Database } from "./database.js";
import { MaintenanceConflict } from "./maintenance-locks.js";

export const COMPACT_LOCK = 1869636993;

/** Hold a shared lock from an import's first database operation until it closes. */
export function compactImportGuard(db: Database): Database {
  // Providers without pinned sessions cannot run compact either.
  if (!db.withSession) return db;
  let start: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let holding: Promise<void> | undefined;
  const ready = () => {
    start ??= new Promise<void>((resolve, reject) => {
      holding = db.withSession!(async (session) => {
        const { rows } = await session.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock_shared(${COMPACT_LOCK}) AS locked`,
        );
        if (!rows[0]?.locked)
          throw new MaintenanceConflict(
            "worker compact is running; retry the import after it finishes",
          );
        try {
          await new Promise<void>((done) => {
            release = done;
            resolve();
          });
        } finally {
          await session.query(
            `SELECT pg_advisory_unlock_shared(${COMPACT_LOCK})`,
          );
        }
      });
      // Attach immediately: a failed lock is reported by the first operation.
      void holding.catch(reject);
    });
    return start;
  };
  return {
    ...db,
    query: async (...args) => {
      await ready();
      return db.query(...args);
    },
    exec: async (...args) => {
      await ready();
      return db.exec(...args);
    },
    transaction: async (run) => {
      await ready();
      return db.transaction(run);
    },
    withSession: async (run) => {
      await ready();
      return db.withSession!(run);
    },
    close: async () => {
      try {
        if (start) {
          await start.catch(() => {});
          release?.();
          await holding?.catch(() => {});
        }
      } finally {
        await db.close();
      }
    },
  };
}
