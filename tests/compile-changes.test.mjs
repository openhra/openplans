import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  compile,
  main,
  NOTES_DIR,
  NotesError,
  parseNote,
  readNotes,
  releaseChangelog,
  splitChangelog,
} from "../scripts/compile-changes.mjs";

const script = fileURLToPath(
  new URL("../scripts/compile-changes.mjs", import.meta.url),
);
const header = "# Changelog\n\nSynthetic intro.\n\n## Unreleased\n";
const history =
  "## v0.1.1\n\nSynthetic released prose.\n\n### Fixes\n\n- Kept byte for byte.\n\n## v0.1.0\n\n- First.\n";
const changelog = `${header}\n- Synthetic legacy bullet.\n\n${history}`;
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});

async function synthetic(notes, text = changelog) {
  const root = await mkdtemp(join(tmpdir(), "openplans-change-notes-"));
  roots.push(root);
  await mkdir(join(root, NOTES_DIR), { recursive: true });
  for (const [name, body] of Object.entries(notes))
    await writeFile(join(root, NOTES_DIR, name), body);
  await writeFile(join(root, "CHANGELOG.md"), text);
  return root;
}

const encode = (text) => new TextEncoder().encode(text);

describe("change notes", () => {
  it("compiles notes in filename order with one blank line between them", async () => {
    const root = await synthetic({
      "zeta-last.md": "- Synthetic last note.\n",
      "alpha-first.md":
        "- Synthetic first note.\n  Continued here.\n- Second bullet.\n",
      "mid-upgrade.md": "Upgrade: run `worker migrate` after upgrading.\n",
    });
    const notes = await readNotes(root);
    expect(notes.map((note) => note.name)).toEqual([
      "alpha-first.md",
      "mid-upgrade.md",
      "zeta-last.md",
    ]);
    expect(compile(notes)).toBe(
      "- Synthetic first note.\n  Continued here.\n- Second bullet.\n\nUpgrade: run `worker migrate` after upgrading.\n\n- Synthetic last note.\n",
    );
    expect(compile([])).toBe("");
  });

  it("treats a missing notes directory as no notes, as in an exported tree", async () => {
    const root = await synthetic({});
    await rm(join(root, NOTES_DIR), { recursive: true });
    expect(await readNotes(root)).toEqual([]);
    expect(await main(["--check"], root)).toBe(0);
  });

  it.each([
    ["Bad_Name.md", "- Synthetic.\n", "lower-case letters"],
    ["note.txt", "- Synthetic.\n", "ending in .md"],
    ["crlf.md", "- Synthetic.\r\n", "LF line endings"],
    ["no-newline.md", "- Synthetic.", "exactly one newline"],
    ["two-newlines.md", "- Synthetic.\n\n", "exactly one newline"],
    ["empty.md", "", "exactly one newline"],
    ["blank-only.md", "\n", "exactly one newline"],
    ["blank-inside.md", "- One.\n\n- Two.\n", "no blank lines inside"],
    ["trailing-space.md", "- Synthetic. \n", "trailing whitespace"],
    ["heading.md", "## Added\n- Synthetic.\n", "no headings"],
    ["dash.md", "-Synthetic.\n", 'a bullet is "- "'],
    ["indent.md", "- One.\n   three spaces.\n", "indented two spaces"],
  ])("rejects %s", (name, text, message) => {
    expect(() => parseNote(name, encode(text))).toThrow(message);
    expect(() => parseNote(name, encode(text))).toThrow(NotesError);
  });

  it("rejects bytes that are not UTF-8", () => {
    expect(() =>
      parseNote("latin.md", new Uint8Array([0x2d, 0x20, 0xe9, 0x0a])),
    ).toThrow("not UTF-8");
  });

  it("accepts bullets, continuation lines and a paragraph", () => {
    const text =
      "- One.\n  More about one.\n- Two.\nUpgrade: a plain paragraph line.\n";
    expect(parseNote("ok-note.md", encode(text))).toBe(text);
  });

  it("splits the changelog around Unreleased without touching the history", () => {
    const parts = splitChangelog(changelog);
    expect(parts.header).toBe(header);
    expect(parts.body).toBe("\n- Synthetic legacy bullet.\n\n");
    expect(parts.history).toBe(history);
    expect(parts.header + parts.body + parts.history).toBe(changelog);
    expect(splitChangelog(`${header}\n${history}`).body).toBe("\n");
    expect(splitChangelog(header).history).toBe("");
    expect(() => splitChangelog("Synthetic\n")).toThrow(
      'start with "# Changelog"',
    );
    expect(() => splitChangelog("# Changelog\n\n## v0.1.0\n")).toThrow(
      "needs a ## Unreleased heading",
    );
  });

  it("inserts a draft section, legacy bullets first, and keeps the history byte-identical", () => {
    const compiled = "- Synthetic note one.\n\n- Synthetic note two.\n";
    const { text, section } = releaseChangelog(changelog, "v0.1.2", compiled);
    expect(section).toBe(
      "## v0.1.2\n\n- Synthetic legacy bullet.\n\n- Synthetic note one.\n\n- Synthetic note two.\n",
    );
    expect(text).toBe(`${header}\n${section}\n${history}`);
    expect(text.endsWith(history)).toBe(true);
    expect(text.startsWith(header)).toBe(true);
    // A second release on the result leaves the first section alone.
    const again = releaseChangelog(text, "v0.1.3", "- Synthetic later.\n");
    expect(again.text.endsWith(`${section}\n${history}`)).toBe(true);
    expect(again.text).toBe(
      `${header}\n## v0.1.3\n\n- Synthetic later.\n\n${section}\n${history}`,
    );
  });

  it("refuses an existing version, a malformed version and an empty release", () => {
    expect(() => releaseChangelog(changelog, "v0.1.1", "- X.\n")).toThrow(
      "already has a v0.1.1 section",
    );
    expect(() => releaseChangelog(changelog, "v0.1.0", "- X.\n")).toThrow(
      "already has a v0.1.0 section",
    );
    expect(() => releaseChangelog(changelog, "0.1.2", "- X.\n")).toThrow(
      "look like v1.2.3",
    );
    expect(() =>
      releaseChangelog(`${header}\n${history}`, "v0.1.2", ""),
    ).toThrow("nothing to release");
  });

  it("runs --release end to end: section written, notes removed, history unchanged", async () => {
    const root = await synthetic(
      {
        "b-second.md": "- Synthetic second.\n",
        "a-first.md": "- Synthetic first.\n",
      },
      `${header}\n${history}`,
    );
    const output = execFileSync(
      process.execPath,
      [script, "--root", root, "--release", "v0.1.2"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(output).toContain(
      "## v0.1.2\n\n- Synthetic first.\n\n- Synthetic second.\n",
    );
    expect(output).toContain("2 note(s) compiled into v0.1.2 and removed");
    const after = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(after).toBe(
      `${header}\n## v0.1.2\n\n- Synthetic first.\n\n- Synthetic second.\n\n${history}`,
    );
    expect(await readNotes(root)).toEqual([]);
    expect(await main(["--check"], root)).toBe(0);
  });

  it("fails --check on a malformed note and names it, through the CLI", async () => {
    const root = await synthetic({
      "ok.md": "- Fine.\n",
      "Bad Name.md": "- Fine.\n",
    });
    const result = (() => {
      try {
        execFileSync(process.execPath, [script, "--root", root, "--check"], {
          cwd: root,
          encoding: "utf8",
          stdio: "pipe",
        });
        return { status: 0, stderr: "" };
      } catch (error) {
        return { status: error.status, stderr: String(error.stderr) };
      }
    })();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("change notes: FAIL Bad Name.md");
    const clean = await synthetic({ "ok.md": "- Fine.\n" });
    await expect(main(["--check", "extra"], clean)).rejects.toThrow(
      "--check takes no argument",
    );
    await expect(main(["--bogus"], clean)).rejects.toThrow("usage:");
    await expect(main(["--release"], clean)).rejects.toThrow("needs a version");
    await expect(main(["--root"], clean)).rejects.toThrow(
      "--root needs a directory",
    );
  });

  it("prints the compiled body and reports legacy bullets on --check", async () => {
    const root = await synthetic({ "one.md": "- Synthetic one.\n" });
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    try {
      expect(await main(["--check"], root)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual([
      "change notes: PASS 1 note(s) plus bullets still under Unreleased (move them to notes)",
    ]);
    expect(
      execFileSync(process.execPath, [script, "--root", root, "--print"], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toBe("- Synthetic one.\n");
  });
});
