import { vi } from "vitest";

// All direct PGlite constructors, including migration and clone tests, use the real server.
if (process.env.OPENPLANS_TEST_DB === "postgres") {
  vi.doMock("@electric-sql/pglite", () => import("./postgres.js"));
}
