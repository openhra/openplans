import { contract } from "./public-contract.js";

const { rest, jsonrpc } = contract.errors;

/** REST errors carry a code; JSON-RPC keeps its numeric protocol codes (docs/public-contract.json). */
export function assertErrorShape(body: unknown): void {
  if (!body || typeof body !== "object" || !(rest.envelope in body))
    throw new Error("Error response is missing error.code");
  const error = (body as Record<string, unknown>)[rest.envelope];
  if (!error || typeof error !== "object" || !("code" in error))
    throw new Error("Error response requires an error object with a code");
  const fields = error as Record<string, unknown>;
  if ("jsonrpc" in body) {
    if (
      body.jsonrpc !== "2.0" ||
      jsonrpc.required.code !== "integer" ||
      !Number.isInteger(fields.code) ||
      !Object.entries(jsonrpc.required).every(
        ([key, type]) =>
          key in fields &&
          (type === "integer"
            ? Number.isInteger(fields[key])
            : typeof fields[key] === type),
      )
    )
      throw new Error("Invalid JSON-RPC error");
  } else if (
    rest.required.code !== "string" ||
    typeof fields.code !== "string" ||
    !fields.code.trim()
  ) {
    throw new Error("REST error.code must be a nonempty string");
  }
}
