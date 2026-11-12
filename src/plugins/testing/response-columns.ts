import { rowProvenanceLeaks } from "../../db/row-provenance.js";

type Request = (input: unknown, ...rest: unknown[]) => unknown;

/** Makes every JSON response of a test app fail the request when it carries such a column. */
export function checkRouteResponses<T extends { request: unknown }>(app: T): T {
  const request = app.request as Request;
  app.request = async (input: unknown, ...rest: unknown[]) => {
    const response = (await request.call(app, input, ...rest)) as Response;
    if (response.headers.get("content-type")?.includes("json")) {
      const url = typeof input === "string" ? input : String(input);
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      const leaks = rowProvenanceLeaks(body, url);
      if (leaks.length)
        throw new Error(
          `Response of ${url} carries database row columns: ${leaks.join(", ")}`,
        );
    }
    return response;
  };
  return app;
}
