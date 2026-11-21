/**
 * The plugin packages shipped in this repository under `plugins/`, except the SDK and the
 * template. A usage report names a loaded plugin only when it is on this list; any other plugin
 * is counted in `other_plugins_count` and never named. A test keeps the list equal to the
 * shipped folders.
 */
export const FIRST_PARTY_PLUGINS = [
  "@openplans/blob-s3",
  "@openplans/plugin-admin",
  "@openplans/plugin-compare",
  "@openplans/plugin-handy",
  "@openplans/plugin-msot",
  "@openplans/plugin-status",
  "@openplans/plugin-tpa",
  "@openplans/plugin-webhook",
  "@openplans/source-carrier-documents",
  "@openplans/source-cms-marketplace-api",
  "@openplans/source-nucc-taxonomy",
  "@openplans/source-rxnav-identity",
] as const;

export type FirstPartyPlugin = (typeof FIRST_PARTY_PLUGINS)[number];

const firstParty: ReadonlySet<string> = new Set(FIRST_PARTY_PLUGINS);

export function isFirstPartyPlugin(name: string): name is FirstPartyPlugin {
  return firstParty.has(name);
}
