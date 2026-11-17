#!/usr/bin/env node
/**
 * Release notes from one file per change. A branch adds `changes/unreleased/<slug>.md`
 * instead of editing the Unreleased section of CHANGELOG.md, so parallel branches never
 * conflict there. At release time the notes become a draft section that the release
 * editor then curates; everything from the first released section on stays byte-identical.
 *
 *   node scripts/compile-changes.mjs --check            validate every note and the CHANGELOG shape
 *   node scripts/compile-changes.mjs --print            print the compiled Unreleased body
 *   node scripts/compile-changes.mjs --release vX.Y.Z   insert `## vX.Y.Z` built from the notes
 *                                                      (bullets still under Unreleased come first)
 *                                                      and delete the compiled notes
 *
 * A note is UTF-8 Markdown with LF line endings and no trailing whitespace: one or more
 * `- ` bullets with two-space continuation lines, or a short paragraph such as an upgrade
 * instruction. No headings, no blank lines, one final newline. Notes compile in filename
 * order, separated by one blank line. `--root DIR` first points at another checkout.
 */
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NOTES_DIR = "changes/unreleased";
const NOTE_NAME = /^[a-z0-9][a-z0-9-]*\.md$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const HEADER = "# Changelog\n";
const UNRELEASED = "\n## Unreleased\n";

export class NotesError extends Error {}

/** Validate one note and return its normalised text (as written: the rules leave no choice). */
export function parseNote(name, bytes) {
  if (!NOTE_NAME.test(name))
    throw new NotesError(
      `${name}: note files are lower-case letters, digits and dashes ending in .md`,
    );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NotesError(`${name}: not UTF-8`);
  }
  if (text.includes("\r")) throw new NotesError(`${name}: use LF line endings`);
  if (!text.endsWith("\n") || text.endsWith("\n\n") || text === "\n")
    throw new NotesError(`${name}: end with exactly one newline`);
  const lines = text.slice(0, -1).split("\n");
  lines.forEach((line, index) => {
    const where = `${name}:${index + 1}`;
    if (line === "")
      throw new NotesError(`${where}: no blank lines inside a note`);
    if (line !== line.trimEnd())
      throw new NotesError(`${where}: trailing whitespace`);
    if (line.startsWith("#"))
      throw new NotesError(`${where}: no headings in a note`);
    if (line.startsWith("-") && !line.startsWith("- "))
      throw new NotesError(`${where}: a bullet is "- " followed by text`);
    if (line.startsWith(" ") && !/^ {2}\S/.test(line))
      throw new NotesError(
        `${where}: continuation lines are indented two spaces`,
      );
  });
  return text;
}

/** Notes in filename order; a missing directory (an exported tree) is an empty list. */
export async function readNotes(root) {
  const directory = join(root, NOTES_DIR);
  let names;
  try {
    names = (await readdir(directory, { withFileTypes: true })).filter((e) =>
      e.isFile(),
    );
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const notes = [];
  for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    notes.push({
      name: entry.name,
      text: parseNote(entry.name, await readFile(join(directory, entry.name))),
    });
  }
  return notes;
}

/** The Unreleased body: notes separated by one blank line, in filename order. */
export function compile(notes) {
  return notes.map((note) => note.text).join("\n");
}

/** Split the changelog into header, Unreleased body and the released history. */
export function splitChangelog(text) {
  if (!text.startsWith(HEADER))
    throw new NotesError(`CHANGELOG.md must start with "${HEADER.trim()}"`);
  const start = text.indexOf(UNRELEASED);
  if (start < 0)
    throw new NotesError("CHANGELOG.md needs a ## Unreleased heading");
  const bodyStart = start + UNRELEASED.length;
  const next = text.indexOf("\n## ", bodyStart - 1);
  const history = next < 0 ? "" : text.slice(next + 1);
  const body = text.slice(bodyStart, next < 0 ? text.length : next + 1);
  return { header: text.slice(0, bodyStart), body, history };
}

/** The changelog with a draft section for `version` inserted and Unreleased left empty. */
export function releaseChangelog(text, version, compiled) {
  if (!VERSION.test(version))
    throw new NotesError(`version must look like v1.2.3, got ${version}`);
  const { header, body, history } = splitChangelog(text);
  if (
    history.includes(`\n## ${version}\n`) ||
    history.startsWith(`## ${version}\n`)
  )
    throw new NotesError(`CHANGELOG.md already has a ${version} section`);
  const legacy = body.trim();
  const parts = [legacy ? legacy + "\n" : "", compiled].filter(Boolean);
  if (!parts.length)
    throw new NotesError(
      "nothing to release: no notes and an empty Unreleased section",
    );
  const section = `## ${version}\n\n${parts.join("\n")}`;
  return {
    text: `${header}\n${section}\n${history}`,
    section,
  };
}

export async function main(
  argv,
  root = resolve(fileURLToPath(new URL("..", import.meta.url))),
) {
  if (argv[0] === "--root") {
    if (argv.length < 2) throw new NotesError("--root needs a directory");
    root = resolve(argv[1]);
    argv = argv.slice(2);
  }
  const [mode, version, extra] = argv;
  const changelogPath = join(root, "CHANGELOG.md");
  if (
    extra !== undefined ||
    !["--check", "--print", "--release"].includes(mode)
  )
    throw new NotesError(
      "usage: compile-changes.mjs --check | --print | --release vX.Y.Z",
    );
  const notes = await readNotes(root);
  const changelog = await readFile(changelogPath, "utf8");
  const { body } = splitChangelog(changelog);
  if (mode === "--check") {
    if (version !== undefined)
      throw new NotesError("--check takes no argument");
    const legacy = body.trim()
      ? " plus bullets still under Unreleased (move them to notes)"
      : "";
    console.log(`change notes: PASS ${notes.length} note(s)${legacy}`);
    return 0;
  }
  if (mode === "--print") {
    if (version !== undefined)
      throw new NotesError("--print takes no argument");
    process.stdout.write(compile(notes));
    return 0;
  }
  if (version === undefined) throw new NotesError("--release needs a version");
  const { text, section } = releaseChangelog(
    changelog,
    version,
    compile(notes),
  );
  await writeFile(changelogPath, text);
  for (const note of notes) await rm(join(root, NOTES_DIR, note.name));
  process.stdout.write(section);
  console.log(
    `\nchange notes: ${notes.length} note(s) compiled into ${version} and removed`,
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        `change notes: FAIL ${error instanceof NotesError ? error.message : error}`,
      );
      process.exit(1);
    },
  );
}
