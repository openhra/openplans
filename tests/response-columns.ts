import { ROW_PROVENANCE_COLUMNS } from "../src/db/row-provenance.js";

const columns = new Set<string>(ROW_PROVENANCE_COLUMNS);

/**
 * Places where a response documents a field that shares a name with a row provenance
 * column. Anything else with one of those names is a table column that got out.
 */
function documented(key: string, path: string[], url: string): boolean {
  // The CMS Marketplace API fallback labels its answers. See src/ingest/cms-api/README.md.
  if (
    path.includes("cms_api") &&
    ["sourced_by", "sourced_at", "sourced_slug"].includes(key)
  )
    return true;
  // The compatibility plan object lists `updated_at`, always null.
  const parent = path.filter((part) => part !== "*").at(-1);
  return (
    key === "updated_at" &&
    url.includes("/compat/v1/") &&
    (parent === "plans" || parent === "plan")
  );
}

// Paths of row provenance columns in a response body; array items show as "*".
export function rowProvenanceLeaks(body: unknown, url = ""): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, [...path, "*"]);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (columns.has(key) && !documented(key, path, url))
          found.add([...path, key].join("/"));
        walk(child, [...path, key]);
      }
    }
  };
  walk(body, []);
  return [...found].sort();
}

type Request = (input: unknown, ...rest: unknown[]) => unknown;

/** Makes every JSON response of a test app fail the request when it carries such a column. */
export function checkResponses<T extends { request: unknown }>(app: T): T {
  const request = app.request as Request;
  app.request = async (input: unknown, ...rest: unknown[]) => {
    const response = (await request(input, ...rest)) as Response;
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
