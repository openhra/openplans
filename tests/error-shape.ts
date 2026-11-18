/** REST errors carry a code; JSON-RPC keeps its numeric protocol codes. */
export function assertErrorShape(body: unknown): void {
  if (!body || typeof body !== "object" || !("error" in body))
    throw new Error("Error response is missing error.code");
  const error = body.error;
  if (!error || typeof error !== "object" || !("code" in error))
    throw new Error("Error response requires an error object with a code");
  if ("jsonrpc" in body) {
    if (
      body.jsonrpc !== "2.0" ||
      typeof error.code !== "number" ||
      !Number.isInteger(error.code) ||
      !("message" in error) ||
      typeof error.message !== "string"
    )
      throw new Error("Invalid JSON-RPC error");
  } else if (typeof error.code !== "string" || !error.code.trim()) {
    throw new Error("REST error.code must be a nonempty string");
  }
}
