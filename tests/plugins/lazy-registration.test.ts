import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import handy from "../../plugins/handy/src/index.js";
import compare from "../../plugins/compare/src/index.js";
import { emitPluginLoaded } from "../../src/plugins/worker.js";

// Enabling a plugin must not slow the API's start or its first requests. Its entry may load
// only the schemas that `tools/list` and input checks need; calculation, evidence and print code
// loads through a dynamic import on the first request or tool call.
const pluginsRoot = fileURLToPath(new URL("../../plugins/", import.meta.url));

const REGISTRATION_MODULES = {
  handy: [
    "allowance/adapters.ts",
    "allowance/contract.ts",
    "allowance/lazy.ts",
    "index.ts",
  ],
  compare: ["index.ts", "input.ts", "lazy.ts", "output.ts"],
} as const;

type Read = (file: string) => string;
const readSource: Read = (file) => readFileSync(file, "utf8");

/**
 * Relative modules a file loads when imported: the static imports and re-exports left after
 * TypeScript drops type-only ones. Dynamic `import()` calls are not followed.
 */
function staticSpecifiers(file: string, read: Read): string[] {
  const output = ts.transpileModule(read(file), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  }).outputText;
  const tree = ts.createSourceFile(file, output, ts.ScriptTarget.ES2022);
  return tree.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
    )
      return [statement.moduleSpecifier.text];
    return [];
  });
}

/** Every plugin source file that importing `src/index.ts` evaluates, relative to `src/`. */
function eagerModules(plugin: string, read: Read = readSource): string[] {
  const source = join(pluginsRoot, plugin, "src");
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of staticSpecifiers(file, read))
      visit(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
  };
  visit(join(source, "index.ts"));
  return [...seen].map((file) => relative(source, file)).sort();
}

/** Adds one static value import to a plugin source file, as a careless edit would. */
function withEagerImport(target: string, line: string): Read {
  return (file) =>
    file === target ? `${line}\n${readSource(file)}` : readSource(file);
}

describe("plugin entries load only registration modules", () => {
  for (const [plugin, expected] of Object.entries(REGISTRATION_MODULES))
    it(`${plugin} keeps calculation and print code out of its entry`, () => {
      expect(eagerModules(plugin)).toEqual(expected);
    });

  it("kills planted eager imports of answer modules", () => {
    const handyMutant = withEagerImport(
      join(pluginsRoot, "handy/src/allowance/adapters.ts"),
      'import { allowanceScenario } from "./service.js";\nvoid allowanceScenario;',
    );
    expect(() =>
      expect(eagerModules("handy", handyMutant)).toEqual(
        REGISTRATION_MODULES.handy,
      ),
    ).toThrow();
    expect(eagerModules("handy", handyMutant)).toContain(
      "allowance/evidence.ts",
    );
    const compareMutant = withEagerImport(
      join(pluginsRoot, "compare/src/index.ts"),
      'export { printMarket } from "./print.js";',
    );
    expect(eagerModules("compare", compareMutant)).toContain("print.ts");
  });

  it("does not count type-only imports as loads", () => {
    const typeOnly = withEagerImport(
      join(pluginsRoot, "compare/src/index.ts"),
      'import type { MarketAnswer } from "./service.js";\nimport { marketCosts } from "./service.js";\nexport type Unused = MarketAnswer | typeof marketCosts;',
    );
    expect(eagerModules("compare", typeOnly)).toEqual(
      REGISTRATION_MODULES.compare,
    );
  });
});

type Work = string[];

/**
 * Runs a plugin's setup with every route and tool switch on, recording any call to the
 * calculation host, database, fetch or a timer. Registration should do none of these.
 */
async function registrationWork(
  plugin: OpenPlansPlugin,
  options?: unknown,
): Promise<{ work: Work; routes: number; tools: number }> {
  const work: Work = [];
  const record =
    (name: string) =>
    (..._args: unknown[]) => {
      work.push(name);
      return Promise.reject(new Error("registration must not call this"));
    };
  for (const timer of ["setTimeout", "setInterval", "setImmediate"] as const)
    vi.spyOn(globalThis, timer).mockImplementation(((..._args: unknown[]) => {
      work.push(timer);
      return undefined;
    }) as never);
  let routes = 0;
  let tools = 0;
  try {
    await plugin.setup({
      plugin: { name: plugin.manifest.name, version: plugin.manifest.version },
      options,
      config: {
        public: { quoting: true, household: true },
        tpa: { enabled: true, privateIngress: true },
      },
      calculationHost: {
        householdDistributions: record("householdDistributions"),
        enumerateHouseholdOffers: record("enumerateHouseholdOffers"),
      },
      db: {
        reader: { query: record("db.query"), exec: record("db.exec") },
      },
      fetch: record("fetch"),
      routes: { add: () => void routes++ },
      mcpTools: { add: () => void tools++ },
      log: () => {},
    } as unknown as Parameters<OpenPlansPlugin["setup"]>[0]);
  } finally {
    vi.restoreAllMocks();
  }
  return { work, routes, tools };
}

afterEach(() => vi.restoreAllMocks());

describe("plugin setup does no request work", () => {
  it("handy registers its routes and tool without calculating", async () => {
    expect(await registrationWork(handy, { publicOnly: false })).toEqual({
      work: [],
      routes: 4,
      tools: 1,
    });
  });

  it("compare registers its routes and tool without calculating", async () => {
    expect(await registrationWork(compare)).toEqual({
      work: [],
      routes: 5,
      tools: 1,
    });
  });

  it("kills a planted warm-up call and a planted timer at setup", async () => {
    const warming: OpenPlansPlugin = {
      ...compare,
      async setup(ctx) {
        await compare.setup(ctx);
        void ctx.calculationHost
          ?.enumerateHouseholdOffers(
            { zip: "77002", year: 2026, age: 40 } as never,
            { db: ctx.db as never, signal: new AbortController().signal },
          )
          .catch(() => {});
      },
    };
    expect((await registrationWork(warming)).work).toEqual([
      "enumerateHouseholdOffers",
    ]);
    const ticking: OpenPlansPlugin = {
      ...handy,
      setup(ctx) {
        handy.setup(ctx);
        setInterval(() => {}, 60_000);
      },
    };
    expect(
      (await registrationWork(ticking, { publicOnly: true })).work,
    ).toEqual(["setInterval"]);
  });
});

describe("plugin.loaded after listen", () => {
  const shipped = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(
      (entry) =>
        (
          JSON.parse(
            readSource(join(pluginsRoot, entry.name, "package.json")),
          ) as { name: string }
        ).name,
    );

  it("keys the shipped plugin set without loading the collator", async () => {
    expect(shipped.length).toBeGreaterThan(5);
    const plugins = [...shipped]
      .reverse()
      .map((name) => ({ name, version: "1.0.0" }));
    const emitted: { idempotencyKey?: string }[] = [];
    const collate = vi.spyOn(String.prototype, "localeCompare");
    await emitPluginLoaded(
      {
        emit: async (event: (typeof emitted)[number]) =>
          void emitted.push(event),
      } as never,
      plugins,
    );
    expect(collate).not.toHaveBeenCalled();
    collate.mockRestore();
    // The key the earlier locale-ordered digest gave for the same set.
    const localeOrdered = [...plugins].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(emitted.map((event) => event.idempotencyKey)).toEqual([
      `plugin.loaded:${createHash("sha256").update(JSON.stringify(localeOrdered)).digest("hex")}`,
    ]);
  });
});
