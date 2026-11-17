import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadMigrations, migrationsDirectory } from "./migrate.js";

/** Copy a validated core migration set for a disposable database, preserving INDEX order. */
export async function copyMigrations(
  directory: string,
  omit: readonly string[],
) {
  const migrations = (await loadMigrations()).filter(
    ({ name }) => !omit.includes(name),
  );
  for (const { name } of migrations)
    await cp(join(migrationsDirectory, name), join(directory, name));
  await writeFile(
    join(directory, "INDEX"),
    migrations.map(({ name }) => name + "\n").join(""),
  );
}
