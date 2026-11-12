import type {
  Event,
  EventPayloads,
  OpenPlansPlugin,
  PluginContext,
} from "@openplans/plugin-sdk";
import { z } from "zod";

export const PLUGIN_NAME = "@openplans/plugin-slack";
export const PLUGIN_VERSION = "0.1.0";
/** Declared secret: the Slack incoming webhook URL. */
export const URL_SECRET = "OPENPLANS_SLACK_WEBHOOK_URL";
/** Not secret: the webhook host, which the plugin declares as its network host. */
export const HOST_VARIABLE = "OPENPLANS_SLACK_HOST";
export const DEFAULT_HOST = "hooks.slack.com";
export const SUBSCRIBER = "slack";
/** Messages per minute before the plugin holds events back and sends one summary per type. */
export const MESSAGES_PER_MINUTE = 20;
const WINDOW_MS = 60_000;
/** Held-back events remembered per type; more are retried by the outbox until there is room. */
const MAX_HELD = 10_000;

export const SEVERITIES = ["info", "warning", "error"] as const;
export type Severity = (typeof SEVERITIES)[number];

type Payload<T extends keyof EventPayloads> = EventPayloads[T];
type SlackEventType =
  | "release.deployed"
  | "ingest.failed"
  | "readiness.failed"
  | "audit.failed"
  | "passthrough.budget_exhausted"
  | "passthrough.breaker_open"
  | "health.changed";

/** A value goes into a message only when it is a short code: no spaces, slashes or `@`. */
function code(value: unknown): string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
    ? value
    : "[withheld]";
}
function count(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? String(value)
    : "[withheld]";
}

const HEALTH_SEVERITY: Record<Payload<"health.changed">["to"], Severity> = {
  ok: "info",
  degraded: "warning",
  down: "error",
};

interface Template<T extends SlackEventType> {
  /** The payload fields the message may read. Nothing else reaches the text. */
  fields: readonly (keyof Payload<T>)[];
  severity: (payload: Payload<T>) => Severity;
  text: (payload: Payload<T>) => string;
  /** Plural noun for the summary of held-back events. */
  plural: string;
}

const TEMPLATES: { [T in SlackEventType]: Template<T> } = {
  "release.deployed": {
    fields: ["version", "previousVersion"],
    severity: () => "info",
    text: (p) =>
      `Release ${code(p.version)} deployed. Previous version: ${
        p.previousVersion === null ? "unknown" : code(p.previousVersion)
      }.`,
    plural: "release messages",
  },
  "ingest.failed": {
    fields: ["sourceId", "reasonCode"],
    severity: () => "error",
    text: (p) =>
      `Ingest failed for ${code(p.sourceId)}: ${code(p.reasonCode)}.`,
    plural: "ingest failures",
  },
  "readiness.failed": {
    fields: ["check", "reasonCode"],
    severity: () => "error",
    text: (p) =>
      `Readiness check ${code(p.check)} failed: ${code(p.reasonCode)}.`,
    plural: "readiness failures",
  },
  "audit.failed": {
    fields: ["step", "reasonCode"],
    severity: () => "error",
    text: (p) => `Audit step ${code(p.step)} failed: ${code(p.reasonCode)}.`,
    plural: "audit failures",
  },
  "passthrough.budget_exhausted": {
    fields: ["sourceId", "dailyMax"],
    severity: () => "warning",
    text: (p) =>
      `Fallback budget used up for ${code(p.sourceId)}: all ${count(
        p.dailyMax,
      )} requests for today are spent.`,
    plural: "fallback budget messages",
  },
  "passthrough.breaker_open": {
    fields: ["sourceId", "untilAt"],
    severity: () => "warning",
    text: (p) =>
      `Fallback paused for ${code(p.sourceId)} after failed calls, until ${code(
        p.untilAt,
      )}.`,
    plural: "fallback pause messages",
  },
  "health.changed": {
    fields: ["component", "from", "to"],
    severity: (p) => HEALTH_SEVERITY[p.to],
    text: (p) =>
      `Health of ${code(p.component)} changed from ${code(p.from)} to ${code(p.to)}.`,
    plural: "health changes",
  },
};

/** The settled event set, in catalog order. */
export const SLACK_EVENTS = Object.keys(TEMPLATES) as SlackEventType[];

/** The payload fields each event's message may read. */
export const MESSAGE_FIELDS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    SLACK_EVENTS.map((type) => [type, TEMPLATES[type].fields as string[]]),
  );

function template(type: string): Template<SlackEventType> | undefined {
  return (TEMPLATES as Record<string, Template<SlackEventType>>)[type];
}

/** Reads only the allowed fields, so a payload key outside the map never reaches the text. */
function allowedPayload(
  type: string,
  payload: unknown,
): Record<string, unknown> {
  const source = (payload ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    (MESSAGE_FIELDS[type] ?? []).map((name) => [name, source[name]]),
  );
}

/** The message for one event, or undefined when the event is outside the settled set. */
export function messageText(event: Pick<Event, "type" | "payload">) {
  const entry = template(event.type);
  if (!entry) return undefined;
  return `OpenPlans: ${entry.text(allowedPayload(event.type, event.payload) as never)}`;
}

export function eventSeverity(event: Pick<Event, "type" | "payload">) {
  return template(event.type)?.severity(
    allowedPayload(event.type, event.payload) as never,
  );
}

/** The summary sent for events held back by the rate limit. */
export function summaryText(type: string, held: number): string {
  const plural = template(type)?.plural ?? "messages";
  return `OpenPlans: The rate limit held back ${held} more ${plural}.`;
}

/** The posted body: a Slack message with the text only. */
export function slackBody(text: string): Buffer {
  return Buffer.from(JSON.stringify({ text }));
}

export const slackOptions = z
  .strictObject({
    /** Event types to post, a subset of the settled set. Default: all seven. */
    events: z
      .array(z.enum(SLACK_EVENTS as [SlackEventType, ...SlackEventType[]]))
      .min(1)
      .refine((list) => new Set(list).size === list.length, {
        message: "Event types must not repeat",
      })
      .optional(),
    /** Events below this severity are dropped without a message. Default: info. */
    minSeverity: z.enum(SEVERITIES).optional(),
  })
  .optional();
export type SlackOptions = z.infer<typeof slackOptions>;

/** Carries a short code only: never the URL or the body. */
export class SlackError extends Error {
  constructor(readonly code: string) {
    super(`slack: ${code}`);
    this.name = "SlackError";
  }
}

/** Up to `capacity` messages per window; the window starts with the first message after a gap. */
export class MessageBudget {
  private windowStart = Number.NEGATIVE_INFINITY;
  private used = 0;
  constructor(
    private readonly now: () => number,
    private readonly capacity = MESSAGES_PER_MINUTE,
  ) {}
  take(): boolean {
    const now = this.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.used = 0;
    }
    if (this.used >= this.capacity) return false;
    this.used += 1;
    return true;
  }
  /** Gives back a message whose post failed. */
  refund(): void {
    if (this.used > 0) this.used -= 1;
  }
}

function webhookUrl(value: string, hosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackError("slack_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !hosts.includes(url.hostname)
  )
    throw new SlackError("slack_url_invalid");
  return url.href;
}

function failureCode(error: unknown): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value)
    ? value
    : "post_failed";
}

function failureStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/**
 * Beyond the budget an event is held: the handler throws, so the outbox keeps it and retries.
 * The first retry that finds room posts one summary for every held event of that type; the
 * other held events are then acknowledged without a message. After a restart the held set is
 * empty and retries post singly, so no event is lost.
 */
function handlerFor(
  ctx: PluginContext,
  url: string,
  budget: MessageBudget,
  minimum: Severity,
): (event: Event) => Promise<void> {
  const held = new Map<string, Set<string>>();
  const summarised = new Set<string>();
  const post = async (event: Event, text: string) => {
    const send = ctx.fetch.post;
    if (!send) throw new SlackError("slack_post_unavailable");
    let status: number;
    try {
      ({ status } = await send(url, {
        body: slackBody(text),
        contentType: "application/json",
      }));
    } catch (error) {
      ctx.log({
        event: "slack_failed",
        event_type: event.type,
        code: failureCode(error),
        status: failureStatus(error),
      });
      throw new SlackError("slack_post_failed");
    }
    if (status < 200 || status > 299) {
      ctx.log({
        event: "slack_failed",
        event_type: event.type,
        code: "http_status",
        status,
      });
      throw new SlackError("slack_post_failed");
    }
  };
  return async (event) => {
    if (summarised.delete(event.id)) return;
    const text = messageText(event);
    const severity = eventSeverity(event);
    if (text === undefined || severity === undefined) return;
    if (SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(minimum)) return;
    const waiting = held.get(event.type) ?? new Set<string>();
    if (!budget.take()) {
      if (waiting.size < MAX_HELD) waiting.add(event.id);
      held.set(event.type, waiting);
      ctx.log({
        event: "slack_held",
        event_type: event.type,
        held: waiting.size,
      });
      throw new SlackError("slack_rate_limited");
    }
    waiting.delete(event.id);
    try {
      await post(
        event,
        waiting.size === 0 ? text : summaryText(event.type, waiting.size + 1),
      );
    } catch (error) {
      budget.refund();
      throw error;
    }
    for (const id of waiting) summarised.add(id);
    held.delete(event.type);
  };
}

/**
 * Notifications to a Slack channel through an incoming webhook. A durable subscriber for the
 * settled event set; `host` becomes the plugin's only network host, so the loader refuses the
 * plugin unless an admission manifest allows it.
 */
export function createSlackPlugin(
  settings: { host?: string; now?: () => number } = {},
): OpenPlansPlugin {
  const host = (settings.host?.trim() || DEFAULT_HOST).toLowerCase();
  const network = /^[a-z0-9.-]{1,253}$/.test(host) ? [host] : [];
  const now = settings.now ?? Date.now;
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      apiVersion: "0.1",
      kinds: ["events"],
      capabilities: { network, secrets: [URL_SECRET] },
      options: slackOptions,
    },
    setup(ctx) {
      const options = slackOptions.parse(ctx.options) ?? {};
      const value = ctx.secrets.get(URL_SECRET);
      if (!value) throw new SlackError("slack_secret_missing");
      const url = webhookUrl(value, network);
      const handler = handlerFor(
        ctx,
        url,
        new MessageBudget(now),
        options.minSeverity ?? "info",
      );
      for (const type of options.events ?? SLACK_EVENTS)
        ctx.events.on(
          type,
          handler as (event: Event<typeof type>) => Promise<void>,
          { durable: true, subscriber: SUBSCRIBER },
        );
    },
  };
}

/** The host comes from `OPENPLANS_SLACK_HOST` when the worker imports the plugin. */
const plugin: OpenPlansPlugin = createSlackPlugin({
  host: process.env[HOST_VARIABLE],
});
export default plugin;
