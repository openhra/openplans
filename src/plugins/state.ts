import type { PluginState, SqlSession } from "@openplans/plugin-sdk";

/** Keys a plugin may use. `core:` keys belong to the host (subscriber installs, schedule ticks). */
const STATE_KEY = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
export const CORE_KEY_PREFIX = "core:";
/** The plugin column for state the core itself keeps. */
export const CORE_STATE_OWNER = "openplans";
/** One value, serialised, may not exceed this. */
export const STATE_VALUE_LIMIT_BYTES = 65_536;

export class PluginStateError extends Error {
  constructor(
    readonly code: "invalid_key" | "invalid_value",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PluginStateError";
  }
}

function checkKey(key: unknown): string {
  if (
    typeof key !== "string" ||
    !STATE_KEY.test(key) ||
    key.toLowerCase().startsWith(CORE_KEY_PREFIX)
  )
    throw new PluginStateError("invalid_key", "key is not allowed");
  return key;
}

function serialise(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined)
    throw new PluginStateError("invalid_value", "value must be JSON");
  if (Buffer.byteLength(text) > STATE_VALUE_LIMIT_BYTES)
    throw new PluginStateError(
      "invalid_value",
      `value exceeds ${STATE_VALUE_LIMIT_BYTES} bytes`,
    );
  return text;
}

/** Read one row of `plugin_state`, for the host's own `core:` keys as well. */
export async function readState(
  session: SqlSession,
  plugin: string,
  key: string,
): Promise<unknown> {
  const { rows } = await session.query<{ value: unknown }>(
    "SELECT value FROM plugin_state WHERE plugin = $1 AND key = $2",
    [plugin, key],
  );
  return rows[0]?.value;
}

export async function writeState(
  session: SqlSession,
  plugin: string,
  key: string,
  text: string,
): Promise<void> {
  await session.query(
    `INSERT INTO plugin_state (plugin, key, value) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (plugin, key) DO UPDATE SET value = EXCLUDED.value`,
    [plugin, key, text],
  );
}

/**
 * `ctx.state` for one plugin: rows of `plugin_state` under the plugin's name. A missing key reads
 * as `undefined`. The session is opened on first use by the caller.
 */
export function pluginState(
  session: () => SqlSession,
  plugin: string,
): PluginState {
  return Object.freeze({
    get: async (key: string) => readState(session(), plugin, checkKey(key)),
    set: async (key: string, value: unknown) => {
      const checked = checkKey(key);
      await writeState(session(), plugin, checked, serialise(value));
    },
    delete: async (key: string) => {
      await session().query(
        "DELETE FROM plugin_state WHERE plugin = $1 AND key = $2",
        [plugin, checkKey(key)],
      );
    },
  });
}
