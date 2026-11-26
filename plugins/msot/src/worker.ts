import { randomUUID } from "node:crypto";
import type {
  CanonicalReader,
  PluginContext,
  WorkerContext,
} from "@openplans/plugin-sdk";
import { z } from "zod";
import { parseFiles, readInput } from "./files.js";
import { Repository } from "./repository.js";
import { resolveInput } from "./schema.js";
import { VersionService } from "./service.js";
import type { Expectation } from "./service.js";

const commands = [
  "validate",
  "preview",
  "import",
  "publish",
  "inspect",
  "export",
  "retire",
  "activate",
] as const;
const allowed: Record<(typeof commands)[number], string[]> = {
  validate: ["file", "csv", "actor"],
  import: ["file", "csv", "actor", "reason", "idempotency-key"],
  preview: ["draft", "input", "actor", "reason", "idempotency-key"],
  publish: [
    "preview",
    "expected-version",
    "expected-activation",
    "actor",
    "reason",
    "idempotency-key",
  ],
  inspect: ["source", "version"],
  export: ["source", "version"],
  activate: [
    "source",
    "version",
    "expected-version",
    "expected-activation",
    "rollback",
    "actor",
    "reason",
    "idempotency-key",
  ],
  retire: [
    "source",
    "version",
    "expected-version",
    "expected-activation",
    "actor",
    "reason",
    "idempotency-key",
  ],
};
function flags(args: string[], permitted: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.slice(2);
    const value = args[i + 1];
    if (
      !args[i]?.startsWith("--") ||
      !name ||
      !permitted.includes(name) ||
      value === undefined ||
      result[name] !== undefined
    )
      throw new Error("msot_invalid_arguments");
    result[name] = value;
  }
  return result;
}
const positive = (value: string) => {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("msot_invalid_arguments");
  return z.number().int().positive().parse(Number(value));
};
export function registerWorker(ctx: PluginContext, reader: CanonicalReader) {
  const service = new VersionService(reader);
  for (const command of commands)
    ctx.workerCommands.add({
      argv: ["msot", command],
      usage: `Usage: worker msot ${command} ${allowed[command].map((k) => `--${k} VALUE`).join(" ")}`,
      timeoutMs: 120000,
      async run(args: string[], run: WorkerContext) {
        try {
          const options = flags(args, allowed[command]);
          const required = (key: string) => {
            const value = options[key];
            if (!value) throw new Error("msot_invalid_arguments");
            return value;
          };
          const repo = new Repository(run.db.reader);
          let result: unknown;
          if (command === "inspect" || command === "export") {
            const inspected = await repo.inspection(
              required("source"),
              options.version ? positive(options.version) : undefined,
            );
            result = command === "export" ? inspected.source : inspected;
          } else {
            const actor = required("actor");
            const meta = {
              actor,
              reason: options.reason ?? "operator_command",
              idempotency_key: options["idempotency-key"] ?? randomUUID(),
            };
            const writer = run.db.writer;
            if (!writer) throw new Error("msot_worker_writer_required");
            run.signal.throwIfAborted();
            if (command === "validate" || command === "import") {
              let candidate;
              try {
                candidate = await parseFiles(
                  await readInput(required("file")),
                  actor,
                  new Date().toISOString(),
                  reader,
                  options.csv ? await readInput(options.csv) : undefined,
                );
              } catch (error) {
                await service.recordRejection(
                  writer,
                  "unknown",
                  command,
                  meta,
                  error,
                );
                throw error;
              }
              result =
                command === "validate"
                  ? await service.validate(writer, candidate, meta)
                  : await service.import(writer, candidate, meta);
            } else if (command === "preview") {
              const input = resolveInput.parse(
                JSON.parse(await readInput(required("input"))),
              );
              result = await service.previewDraft(
                writer,
                required("draft"),
                input,
                run.signal,
                meta,
              );
            } else {
              const expectedVersion = required("expected-version");
              const activation = required("expected-activation");
              if (!/^(0|[1-9][0-9]*)$/.test(activation))
                throw new Error("msot_invalid_arguments");
              const expected: Expectation = {
                version:
                  expectedVersion === "none" ? null : positive(expectedVersion),
                activation: Number(activation),
              };
              if (command === "publish")
                result = await service.publish(
                  writer,
                  required("preview"),
                  expected,
                  meta,
                  run.events,
                  run.signal,
                );
              else {
                if (options.rollback && options.rollback !== "true")
                  throw new Error("msot_invalid_arguments");
                let operation: "activate" | "rollback" | "retire" = "activate";
                if (command === "retire") operation = "retire";
                else if (options.rollback) operation = "rollback";
                result = await service.activate(
                  writer,
                  required("source"),
                  positive(required("version")),
                  expected,
                  meta,
                  run.events,
                  operation,
                );
              }
            }
          }
          console.log(JSON.stringify(result));
          return 0;
        } catch (error) {
          const code =
            error instanceof Error && /^MSOT_[A-Z_]+$/.test(error.message)
              ? error.message
              : "msot_command_refused";
          run.log({ event: "msot_command_refused", code, operation: command });
          return 1;
        }
      },
    });
}
