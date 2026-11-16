import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import type { PeerAddress } from "../api/rate-limit.js";
import { credentialMatches } from "../compat/v1/auth.js";

export const ADMIN_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
export function adminHeaders(c: Context) {
  c.header("Cache-Control", "no-store");
  c.header("Content-Security-Policy", ADMIN_CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
}

export function privateTransport(
  c: Context,
  origin: string,
  trustedProxies: readonly string[],
  peerAddress?: PeerAddress,
): boolean {
  const url = new URL(c.req.url);
  const configured = new URL(origin);
  if ((c.req.header("host") ?? url.host) !== configured.host) return false;
  let peer = peerAddress?.(c.req.raw);
  if (!peer) {
    try {
      peer = getConnInfo(c).remote.address;
    } catch {
      /* In-process direct TLS only. */
    }
  }
  const forwarded = [...c.req.raw.headers.keys()].filter(
    (name) => name === "forwarded" || name.startsWith("x-forwarded-"),
  );
  if (forwarded.length) {
    if (!peer || !trustedProxies.includes(peer)) return false;
    // One reviewed TLS terminator, with no ambiguous chain or alternative forwarding dialect.
    if (
      forwarded.some(
        (name) =>
          ![
            "x-forwarded-for",
            "x-forwarded-proto",
            "x-forwarded-host",
          ].includes(name),
      )
    )
      return false;
    if (
      c.req.header("x-forwarded-proto") !== "https" ||
      c.req.header("x-forwarded-host") !== configured.host
    )
      return false;
    const source = c.req.header("x-forwarded-for");
    if (source?.includes(",")) return false;
    return true;
  }
  return url.origin === origin && url.protocol === "https:";
}
export function validCsrf(
  c: Context,
  origin: string,
  submitted: string | undefined,
  expected: string,
) {
  return (
    c.req.header("origin") === origin && credentialMatches(submitted, expected)
  );
}

/** Strict, small ordinary forms. No file, JSON, repeated field or query credential support. */
export async function readAdminForm(
  c: Context,
  signal?: AbortSignal,
): Promise<URLSearchParams | undefined> {
  if (
    !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(
      c.req.header("content-type") ?? "",
    )
  )
    return undefined;
  const reader = c.req.raw.body?.getReader();
  if (!reader || signal?.aborted) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return undefined;
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  // Leave the validated bounded body available to the plugin's ordinary Hono form parser.
  c.req.raw = new Request(c.req.raw, { body: text });
  const form = new URLSearchParams(text);
  const keys = [...form.keys()];
  if (new Set(keys).size !== keys.length) return undefined;
  return form;
}
