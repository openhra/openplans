import { z } from "zod";

export const PLUGIN_API_VERSION = "0.1" as const;

const numericVersion = "(?:0|[1-9][0-9]*)";
const prereleaseIdentifier = "(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)";
const semanticVersion = new RegExp(
  `^${numericVersion}\\.${numericVersion}\\.${numericVersion}` +
    `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?` +
    "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$",
);

export const pluginManifestSchema = z.strictObject({
  name: z.string().regex(/^[@a-z0-9][a-z0-9/._-]{1,100}$/),
  version: z.string().regex(semanticVersion),
  apiVersion: z.literal(PLUGIN_API_VERSION),
  kinds: z.array(
    z.enum([
      "routes",
      "mcpTools",
      "cacheStores",
      "dbProviders",
      "blobStores",
      "sources",
      "workerCommands",
      "schedules",
      "events",
    ]),
  ),
  capabilities: z
    .strictObject({
      network: z.array(z.string()).optional(),
      secrets: z.array(z.string()).optional(),
      writes: z
        .array(z.enum(["staging", "cache", "blobs", "events"]))
        .optional(),
      operatorRoutes: z.boolean().optional(),
      /** The module's `createPlugin({ host })` gets read-only host status (`StatusHost`). */
      hostStatus: z.boolean().optional(),
    })
    .optional(),
  /**
   * Required to ship `migrations/*.sql`: every object a migration creates or alters is named
   * `plg_<tablePrefix>_...`. Unique across the loaded plugins.
   */
  tablePrefix: z
    .string()
    .regex(/^[a-z][a-z0-9]{1,15}$/)
    .optional(),
  options: z.instanceof(z.ZodType).optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginKind = PluginManifest["kinds"][number];
export * from "./contracts.js";
export * from "./events.js";
export * from "./sources.js";
export * from "./csv.js";
