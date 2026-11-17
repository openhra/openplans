import { fromJsonSchema } from "@modelcontextprotocol/server";
import type { JsonSchemaType, Tool } from "@modelcontextprotocol/server";

const definitions = new WeakMap<object, Tool>();
const schemas = new WeakMap<
  JsonSchemaType,
  {
    converted: ReturnType<typeof fromJsonSchema>;
    prepare: () => void;
  }
>();

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** Keys identify static definitions, plugin specs, or one switched tool's exposure scope. */
export function cachedToolDefinition(key: object, build: () => Tool): Tool {
  let definition = definitions.get(key);
  if (!definition) {
    definition = build();
    freeze(definition);
    definitions.set(key, definition);
  }
  return definition;
}

/** Compiled validation contains no request state; servers and callbacks remain per request. */
export function cachedJsonSchema(schema: JsonSchemaType, prepare = false) {
  let cached = schemas.get(schema);
  if (!cached) {
    // Discovery needs the schema, but only a called tool needs its compiled validator.
    let compiled: ReturnType<typeof fromJsonSchema> | undefined;
    cached = {
      prepare: () => {
        compiled ??= fromJsonSchema(schema);
      },
      converted: {
        "~standard": {
          version: 1,
          vendor: "mcp",
          jsonSchema: {
            input: () => schema,
            output: () => schema,
          },
          validate: (data) =>
            (compiled ??= fromJsonSchema(schema))["~standard"].validate(data),
        },
      },
    };
    schemas.set(schema, cached);
  }
  if (prepare) cached.prepare();
  return cached.converted;
}
