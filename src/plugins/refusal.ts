export const REFUSAL_CODES = [
  "plugin_approval_refused",
  "plugin_import_failed",
  "plugin_export_invalid",
  "plugin_api_version_mismatch",
  "plugin_name_duplicate",
  "plugin_table_prefix_duplicate",
  "plugin_secret_missing",
  "plugin_network_host_not_allowed",
  "plugin_options_invalid",
  "plugin_kind_undeclared",
  "plugin_registration_invalid",
  "plugin_route_collision",
  "plugin_mcp_tool_collision",
  "plugin_registration_collision",
  "mcp_tool_page_overflow",
  "plugin_provider_collision",
  "plugin_provider_unknown",
  "plugin_setup_failed",
  "passthrough_level_loosened",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Carries only fixed codes and reasons, so the startup log line never holds a configured value. */
export class PluginRefusal extends Error {
  constructor(
    readonly plugin: string,
    readonly code: RefusalCode,
    readonly reason?: string,
  ) {
    super(code);
    this.name = "PluginRefusal";
  }
}
