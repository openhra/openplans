import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { z } from "zod";

/** Rename this, the route, the tool, the command and the subscriber before you ship a copy. */
export const PLUGIN_NAME = "@openplans/plugin-template";
export const HELLO_PATH = "/template/hello";
export const HELLO_TOOL = "template_hello";
export const HELLO_ARGV = ["template", "hello"] as const;
export const SUBSCRIBER = "template";
/** The `ctx.state` key where the worker command counts its runs. */
export const RUNS_KEY = "hello-runs";

const DEFAULT_NAME = "world";
// Letters, spaces and hyphens only, so a greeting never echoes markup or control characters.
const nameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z -]{0,39}$/)
  .default(DEFAULT_NAME);

export const optionsSchema = z
  .strictObject({ greeting: z.string().min(1).max(40).default("hello") })
  // Lets the plugin load from OPENPLANS_PLUGINS, which passes no options.
  .prefault({});
export type TemplateOptions = z.infer<typeof optionsSchema>;

export const helloInput = z.strictObject({ name: nameSchema.optional() });
export const helloOutput = z.strictObject({ greeting: z.string() });
export type HelloOutput = z.infer<typeof helloOutput>;

export function greet(greeting: string, name = DEFAULT_NAME): HelloOutput {
  return { greeting: `${greeting}, ${name}` };
}

const plugin: OpenPlansPlugin = {
  manifest: {
    name: PLUGIN_NAME,
    version: "0.1.0",
    apiVersion: "0.1",
    kinds: ["routes", "mcpTools", "workerCommands", "events"],
    options: optionsSchema,
  },
  setup(ctx) {
    const { greeting } = ctx.options as TemplateOptions;

    ctx.routes.add({
      method: "GET",
      path: HELLO_PATH,
      exposure: "public",
      contentType: "application/json",
      cache: { ttlSeconds: 60 },
      handler: (c) => {
        const name = nameSchema.safeParse(c.req.query("name"));
        if (!name.success) return c.json({ error: "invalid_name" }, 400);
        return c.json(greet(greeting, name.data));
      },
    });

    ctx.mcpTools.add({
      name: HELLO_TOOL,
      title: "Template greeting",
      description: "Returns a greeting for a name. It reads no data.",
      inputSchema: helloInput,
      outputSchema: helloOutput,
      readOnly: true,
      handler: async (input) => greet(greeting, input.name),
    });

    ctx.workerCommands.add({
      argv: HELLO_ARGV,
      usage: "worker template hello",
      timeoutMs: 10_000,
      run: async (args, worker) => {
        if (args.length > 0) {
          worker.log({
            code: "template_usage",
            usage: "worker template hello",
          });
          return 1;
        }
        const previous = await worker.state.get(RUNS_KEY);
        const runs = (typeof previous === "number" ? previous : 0) + 1;
        await worker.state.set(RUNS_KEY, runs);
        worker.log({ code: "template_hello", runs });
        return 0;
      },
    });

    // Non-durable: runs in the process that emits the event, once, with no retry.
    ctx.events.on(
      "snapshot.activated",
      async (event) => {
        ctx.log({
          code: "template_snapshot_seen",
          source: event.payload.sourceId,
        });
      },
      { durable: false, subscriber: SUBSCRIBER },
    );
  },
};

export default plugin;
