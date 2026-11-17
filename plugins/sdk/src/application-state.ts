import { z } from "zod";

export const applicationStateDeclarationSchema = z.strictObject({
  table: z
    .string()
    .regex(/^plg_[a-z0-9_]+$/)
    .max(63),
  reason: z.string().max(200).trim().min(1),
  catalogImpact: z.enum(["catalog", "operational"]).optional(),
});

export type ApplicationStateDeclaration = z.infer<
  typeof applicationStateDeclarationSchema
>;
export type ApplicationStateCatalogImpact = "catalog" | "operational";

/** Core-reviewed bookkeeping tables; application provenance alone grants no exemption. */
export function applicationStateCatalogImpact(
  plugin: string,
  tablePrefix: string,
  table: string,
): ApplicationStateCatalogImpact {
  if (
    plugin === "@openplans/plugin-admin" &&
    tablePrefix === "admin" &&
    table === "plg_admin_telemetry"
  )
    return "operational";
  return plugin === "@openplans/plugin-msot" &&
    tablePrefix === "msot" &&
    ["plg_msot_draft", "plg_msot_preview", "plg_msot_audit"].includes(table)
    ? "operational"
    : "catalog";
}

/** A declaration cannot choose a classification the host has not reviewed. */
export function applicationStateDeclarationAllowed(
  plugin: string,
  tablePrefix: string | undefined,
  entry: ApplicationStateDeclaration,
): boolean {
  return (
    tablePrefix !== undefined &&
    /^[a-z][a-z0-9]{1,15}$/.test(tablePrefix) &&
    entry.table.startsWith(`plg_${tablePrefix}_`) &&
    entry.table.length > `plg_${tablePrefix}_`.length &&
    (entry.catalogImpact === undefined ||
      entry.catalogImpact ===
        applicationStateCatalogImpact(plugin, tablePrefix, entry.table))
  );
}
