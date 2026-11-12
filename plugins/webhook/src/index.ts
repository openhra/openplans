import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type {
  Event,
  EventType,
  OpenPlansPlugin,
  PluginContext,
} from "@openplans/plugin-sdk";
import { z } from "zod";
import { EVENT_ID_HEADER, SIGNATURE_HEADER, signBody } from "./signature.js";

export {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  signBody,
  verifySignature,
} from "./signature.js";

export const PLUGIN_NAME = "@openplans/plugin-webhook";
export const PLUGIN_VERSION = "0.1.0";
/** Declared secret: the receiver's full HTTPS URL. */
export const URL_SECRET = "OPENPLANS_WEBHOOK_URL";
/** Declared secret: the HMAC key shared with the receiver. */
export const HMAC_SECRET = "OPENPLANS_WEBHOOK_SECRET";
/** Not secret: the receiver's host name, which the plugin declares as its network host. */
export const HOST_VARIABLE = "OPENPLANS_WEBHOOK_HOST";
export const SUBSCRIBER = "webhook";
export const MIN_SECRET_LENGTH = 32;

const eventTypes = Object.keys(eventPayloadSchemas) as [
  EventType,
  ...EventType[],
];

export const webhookOptions = z.strictObject({
  /** Event types to post, a subset of the catalog. */
  events: z
    .array(z.enum(eventTypes))
    .min(1)
    .refine((list) => new Set(list).size === list.length, {
      message: "Event types must not repeat",
    }),
});
export type WebhookOptions = z.infer<typeof webhookOptions>;

/** Carries a short code only: never the URL, the secret or the body. */
export class WebhookError extends Error {
  constructor(readonly code: string) {
    super(`webhook: ${code}`);
    this.name = "WebhookError";
  }
}

/** The posted body: the delivered event, unchanged, as compact JSON. */
export function webhookBody(event: Event): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: event.id,
      type: event.type,
      emittedAt: event.emittedAt,
      emittedBy: event.emittedBy,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
    }),
  );
}

function receiverUrl(value: string, hosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookError("webhook_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !hosts.includes(url.hostname)
  )
    throw new WebhookError("webhook_url_invalid");
  return url.href;
}

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
    ? code
    : "post_failed";
}

function failureStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function handlerFor(
  ctx: PluginContext,
  url: string,
  secret: string,
): (event: Event) => Promise<void> {
  return async (event) => {
    const post = ctx.fetch.post;
    if (!post) throw new WebhookError("webhook_post_unavailable");
    const body = webhookBody(event);
    let status: number;
    try {
      ({ status } = await post(url, {
        body,
        contentType: "application/json",
        headers: {
          [SIGNATURE_HEADER]: signBody(secret, body),
          [EVENT_ID_HEADER]: event.id,
        },
      }));
    } catch (error) {
      ctx.log({
        event: "webhook_failed",
        event_type: event.type,
        code: failureCode(error),
        status: failureStatus(error),
      });
      throw new WebhookError("webhook_post_failed");
    }
    // The host already rejects non-2xx; this keeps the rule if a host does not.
    if (status < 200 || status > 299) {
      ctx.log({
        event: "webhook_failed",
        event_type: event.type,
        code: "http_status",
        status,
      });
      throw new WebhookError("webhook_post_failed");
    }
  };
}

/**
 * A durable subscriber that posts each chosen event as signed JSON. `host` becomes the plugin's
 * only network host, so the loader refuses the plugin unless an admission manifest allows it.
 */
export function createWebhookPlugin(
  settings: { host?: string } = {},
): OpenPlansPlugin {
  const host = settings.host?.trim().toLowerCase();
  const network = host && /^[a-z0-9.-]{1,253}$/.test(host) ? [host] : [];
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      apiVersion: "0.1",
      kinds: ["events"],
      capabilities: { network, secrets: [URL_SECRET, HMAC_SECRET] },
      options: webhookOptions,
    },
    setup(ctx) {
      const { events } = webhookOptions.parse(ctx.options);
      const value = ctx.secrets.get(URL_SECRET);
      const secret = ctx.secrets.get(HMAC_SECRET);
      if (!value || !secret) throw new WebhookError("webhook_secret_missing");
      if (secret.length < MIN_SECRET_LENGTH)
        throw new WebhookError("webhook_secret_too_short");
      const url = receiverUrl(value, network);
      const handler = handlerFor(ctx, url, secret);
      for (const type of events)
        ctx.events.on(
          type,
          handler as (event: Event<typeof type>) => Promise<void>,
          {
            durable: true,
            subscriber: SUBSCRIBER,
          },
        );
    },
  };
}

/** The receiver's host comes from `OPENPLANS_WEBHOOK_HOST` when the worker imports the plugin. */
const plugin: OpenPlansPlugin = createWebhookPlugin({
  host: process.env[HOST_VARIABLE],
});
export default plugin;
