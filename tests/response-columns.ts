import type { Hono } from "hono";
import { checkRouteResponses } from "../src/plugins/testing/response-columns.js";
import { assertErrorShape } from "./error-shape.js";

export { rowProvenanceLeaks } from "../src/db/row-provenance.js";

/** Check every API error reached by the test suite, through request or fetch. */
export function checkResponses<T extends Hono>(app: T): T {
  checkRouteResponses(app);
  const fetch = app.fetch;
  app.fetch = async (...args: Parameters<Hono["fetch"]>) => {
    const response = await fetch(...args);
    if (
      response.status >= 400 &&
      response.headers.get("content-type")?.includes("json")
    )
      assertErrorShape(await response.clone().json());
    return response;
  };
  return app;
}
