import { createHash, createHmac, randomBytes } from "node:crypto";
import { credentialMatches } from "../compat/v1/auth.js";

export const SESSION_COOKIE = "__Secure-openplans_admin";
export const LOGIN_COOKIE = "__Secure-openplans_admin_login";
export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 8 * 60 * 60_000;
export const NONCE_MS = 10 * 60_000;
export const MAX_SESSIONS = 256;
export const MAX_NONCES = 512;
const opaque = () => randomBytes(32).toString("base64url");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const validId = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export interface AdminSession {
  csrfToken: string;
  authenticatedAt: number;
}
interface RecordState {
  createdAt: number;
  seenAt: number;
  authenticatedAt: number;
}

/** Process-local authorization. Restart and credential/configuration changes revoke all records. */
export function createSessionStore(now: () => number = Date.now) {
  const sessions = new Map<string, RecordState>();
  const nonces = new Map<string, number>();
  const csrfKey = randomBytes(32);
  let authority: string | undefined;
  const csrf = (key: string) =>
    createHmac("sha256", csrfKey).update(key).digest("base64url");
  function prune() {
    const time = now();
    for (const [key, state] of sessions)
      if (
        time - state.seenAt >= IDLE_MS ||
        time - state.createdAt >= ABSOLUTE_MS
      )
        sessions.delete(key);
    for (const [key, expires] of nonces)
      if (expires <= time) nonces.delete(key);
  }
  return {
    synchronize(value: string | undefined) {
      const next = value ? digest(value) : undefined;
      if (authority !== next || !next) {
        sessions.clear();
        nonces.clear();
        authority = next;
      }
      prune();
    },
    nonce() {
      prune();
      if (!authority || nonces.size >= MAX_NONCES) return undefined;
      const value = opaque();
      nonces.set(digest(value), now() + NONCE_MS);
      return value;
    },
    consumeNonce(cookie: string, submitted: string) {
      prune();
      const key = digest(cookie);
      const exists = nonces.delete(key);
      return exists && validId(cookie) && credentialMatches(submitted, cookie);
    },
    issue(previous?: string) {
      prune();
      if (previous) sessions.delete(digest(previous));
      if (!authority || sessions.size >= MAX_SESSIONS) return undefined;
      const id = opaque();
      const time = now();
      sessions.set(digest(id), {
        createdAt: time,
        seenAt: time,
        authenticatedAt: time,
      });
      return id;
    },
    read(id: string): AdminSession | undefined {
      prune();
      if (!validId(id)) return undefined;
      const key = digest(id);
      const state = sessions.get(key);
      if (!state) return undefined;
      state.seenAt = now();
      return { csrfToken: csrf(key), authenticatedAt: state.authenticatedAt };
    },
    renew(id: string) {
      prune();
      const state = sessions.get(digest(id));
      if (!state) return undefined;
      sessions.delete(digest(id));
      const next = opaque();
      // Recent authentication does not extend the original eight-hour session lifetime.
      sessions.set(digest(next), {
        ...state,
        seenAt: now(),
        authenticatedAt: now(),
      });
      return next;
    },
    revoke(id: string) {
      return sessions.delete(digest(id));
    },
  };
}

export function readCookie(header: string | undefined, name: string): string {
  const matches = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : "";
}
export function adminCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
