import { z } from "zod";

const url = z.string().transform((input, context) => {
  try {
    const parsed = new URL(input);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !["file:", "https:", "http:"].includes(parsed.protocol) ||
      (parsed.protocol === "file:" && parsed.host) ||
      (parsed.protocol === "http:" && parsed.hostname !== "127.0.0.1")
    )
      throw new Error();
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    return parsed.href;
  } catch {
    context.addIssue({ code: "custom", message: "registry_url_refused" });
    return z.NEVER;
  }
});
export const registryDefinitionSchema = z.strictObject({
  url,
  root: z.string().min(1),
  mirrors: z.array(url).max(32).optional(),
  namespaces: z
    .array(z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/))
    .min(1)
    .max(100)
    .optional(),
});
export const registryDefinitionsSchema = z
  .array(registryDefinitionSchema)
  .max(32)
  .superRefine((entries, context) => {
    const urls = new Set<string>();
    const namespaces = new Set<string>();
    for (const entry of entries) {
      for (const value of [entry.url, ...(entry.mirrors ?? [])]) {
        if (urls.has(value))
          context.addIssue({
            code: "custom",
            message: "registry_duplicate_trust",
          });
        urls.add(value);
      }
      for (const value of entry.namespaces ?? []) {
        if (namespaces.has(value))
          context.addIssue({
            code: "custom",
            message: "registry_namespace_conflict",
          });
        namespaces.add(value);
      }
    }
  });
export type RegistryDefinition = z.infer<typeof registryDefinitionSchema>;
