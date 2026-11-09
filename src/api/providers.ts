import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SqlSession } from "../db/database.js";
import {
  findProviders,
  getProvider,
  checkProviderNetwork,
  checkProviderNetworks,
} from "../services/providers.js";
import * as v from "./validation.js";

export function providerRoutes(db: SqlSession) {
  const app = new Hono();
  app.get("/providers", async (c) =>
    c.json(await findProviders(db, c.req.query())),
  );
  app.get("/providers/:npi", async (c) =>
    c.json(await getProvider(db, c.req.param("npi"), c.req.query("year"))),
  );
  app.get("/plans/:id/providers/:npi", async (c) =>
    c.json(
      await checkProviderNetwork(
        db,
        c.req.param("id"),
        c.req.param("npi"),
        c.req.query("year"),
      ),
    ),
  );
  app.post(
    "/provider-participation",
    bodyLimit({
      maxSize: 65_536,
      onError: (c) =>
        c.json({ error: { code: "REQUEST_TOO_LARGE", field: "body" } }, 400),
    }),
    async (c) => {
      let value: unknown;
      try {
        value = await c.req.json();
      } catch {
        return v.fail("body", "INVALID_JSON");
      }
      return c.json(await checkProviderNetworks(db, value));
    },
  );
  return app;
}
