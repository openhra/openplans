import type {
  FeedSource,
  PluginContext,
  WorkerCommandSpec,
  WorkerContext,
} from "@openplans/plugin-sdk";
import type { Database } from "../../db/database.js";
import type { RegisteredSource } from "../registries.js";
import type { PluginWorkerCommand } from "../worker.js";
import { runFeedSource } from "./feed.js";
import type { FeedRunOptions } from "./feed.js";

export { runFeedSource } from "./feed.js";
export type { FeedDatabase, FeedRunOptions, FeedRunSummary } from "./feed.js";

/**
 * One worker command per registered feed source, at the source's own argv. The command needs
 * the writer, so a feed plugin must declare `capabilities.writes` with "staging". Each run checks
 * the source's hosts against the plugin's declared network hosts.
 */
export function feedWorkerCommands(
  sources: readonly RegisteredSource[],
  writers: ReadonlySet<string>,
  config: PluginContext["config"],
  options: FeedRunOptions = {},
): PluginWorkerCommand[] {
  return sources
    .filter(
      (entry): entry is RegisteredSource & { spec: FeedSource } =>
        entry.spec.kind === "feed",
    )
    .map(({ plugin, spec: source, network }) => {
      const spec: WorkerCommandSpec = Object.freeze({
        argv: Object.freeze([...source.command.argv]),
        usage: source.command.usage,
        source: source.id,
        async run(args: string[], ctx: WorkerContext) {
          // Plugin commands receive { reader, writer? } whatever the SDK's type says today.
          const writer = (ctx.db as unknown as { writer?: Database }).writer;
          if (!writer) {
            (options.output ?? console).error(
              JSON.stringify({ plugin, code: "feed_source_requires_staging" }),
            );
            return 1;
          }
          return runFeedSource(source, args, writer, {
            ...options,
            declaredHosts: network,
          });
        },
      });
      return Object.freeze({
        plugin,
        spec,
        writer: writers.has(plugin),
        config,
      });
    });
}
