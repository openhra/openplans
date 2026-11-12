// Pins of the PBP archives and dictionary members behind the cost-bound rules, and the checks of
// data/medicare-part-d/cost-bounds.json. Bytes in the failure cases are synthetic.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundErrors,
  boundsFile,
  crossManifestErrors,
  documentErrors,
  documentsFile,
  memberErrors,
  memberPinErrors,
  pbpDocumentsFile,
  pinErrors,
  zipMember,
} from "../../../scripts/medicare-costs/check.mjs";
import { zip } from "../../ingest/medicare/helpers.js";

interface Citation {
  document: string;
  section: string;
  page?: number;
  member?: string;
  sheet?: string;
  row?: number;
  quote: string;
}
interface Member {
  name: string;
  sha256: string;
  bytes: number;
  sheet: string;
}
interface Doc {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  contentType: string;
  contractYear?: number;
  members?: Member[];
}
interface Manifest {
  schemaVersion: number;
  cacheSource: string;
  documents: Doc[];
}
interface Section {
  code?: string;
  citations: Citation[];
  [key: string]: unknown;
}
interface Bounds {
  schemaVersion: number;
  years: Record<string, Record<string, Section>>;
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8")) as T;
const rules = read<Manifest>(documentsFile);
const pbp = read<Manifest>(pbpDocumentsFile);
const bounds = read<Bounds>(boundsFile);
const copy = <T>(value: T): T => structuredClone(value);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("PBP archive pins and bound rule citations", () => {
  it("pass the structural and citation checks", () => {
    expect(documentErrors(pbp)).toEqual([]);
    expect(memberErrors(pbp)).toEqual([]);
    expect(crossManifestErrors([rules, pbp])).toEqual([]);
    expect(boundErrors(bounds, [rules, pbp])).toEqual([]);
  });

  it("cite each year's own dictionary rows and LIS column", () => {
    const rows = (year: string) =>
      Object.values(bounds.years[year]!).flatMap((section) =>
        section.citations.flatMap((citation) =>
          citation.row ? [`${citation.document}:${citation.row}`] : [],
        ),
      );
    expect(rows("2026")).toEqual(["C13:25630", "C13:25631", "C13:25379"]);
    expect(rows("2027")).toEqual(["C14:26821", "C14:26822", "C14:26544"]);
    const lis = (year: string) => bounds.years[year]!.lisMaximumCopays!;
    expect(lis("2026")).toMatchObject({
      genericUpTo100FplCents: 160,
      otherUpTo100FplCents: 490,
      genericAbove100FplCents: 510,
      otherAbove100FplCents: 1265,
    });
    expect(lis("2027")).toMatchObject({
      genericUpTo100FplCents: 165,
      otherUpTo100FplCents: 500,
      genericAbove100FplCents: 580,
      otherAbove100FplCents: 1440,
    });
    expect(lis("2026").citations[0]).toMatchObject({
      document: "C5",
      page: 95,
    });
  });

  it("fail an unpinned member, another sheet, another year's archive or a missing row", () => {
    const join = (value: Bounds) => boundErrors(value, [rules, pbp]).join("\n");
    const member = copy(bounds);
    member.years["2026"]!.greaterOf!.citations[0]!.member = "other.xlsx";
    expect(join(member)).toMatch(/unpinned member/);
    const sheet = copy(bounds);
    sheet.years["2026"]!.greaterOf!.citations[0]!.sheet = "Sheet2";
    expect(join(sheet)).toMatch(/another sheet/);
    const swapped = copy(bounds);
    swapped.years["2026"]!.greaterOf = copy(bounds.years["2027"]!.greaterOf!);
    expect(join(swapped)).toMatch(/cites the 2027 archive/);
    const rowless = copy(bounds);
    delete rowless.years["2027"]!.definedStandard!.citations[0]!.row;
    expect(join(rowless)).toMatch(/needs a data row/);
    const column = copy(bounds);
    column.years["2026"]!.lisMaximumCopays = copy(
      bounds.years["2027"]!.lisMaximumCopays!,
    );
    expect(join(column)).toMatch(/another year's column/);
    const order = copy(bounds);
    order.years["2026"]!.lisMaximumCopays!.genericUpTo100FplCents = 600;
    expect(join(order)).toMatch(/lower income level/);
    const pageless = copy(bounds);
    delete pageless.years["2026"]!.lisMaximumCopays!.citations[0]!.page;
    expect(join(pageless)).toMatch(/PDF without a page/);
    const extra = copy(bounds);
    extra.years["2028"] = copy(bounds.years["2027"]!);
    expect(join(extra)).toMatch(/years must be exactly/);
  });

  it("fail a zip pin without members or a year, and an id used twice", () => {
    const bare = copy(pbp);
    delete bare.documents[0]!.members;
    delete bare.documents[1]!.contractYear;
    expect(memberErrors(bare).join("\n")).toMatch(/needs its cited members/);
    expect(memberErrors(bare).join("\n")).toMatch(/contractYear/);
    const twice = copy(pbp);
    twice.documents[0]!.id = "C5";
    expect(crossManifestErrors([rules, twice])).toEqual([
      "C5: id used by two manifests",
    ]);
  });
});

describe("PBP member pins", () => {
  // SYNTHETIC archive: one deflated and one stored member stand in for the cached zip.
  const content = Buffer.from("synthetic dictionary bytes\n".repeat(40));
  function deflatedZip(name: string, bytes: Buffer) {
    // Rewrite the stored helper zip's single member as deflated.
    const stored = zip({ [name]: bytes });
    const packed = deflateRawSync(bytes);
    const nameLength = Buffer.byteLength(name);
    const local = Buffer.from(stored.subarray(0, 30 + nameLength));
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    const central = Buffer.from(
      stored.subarray(30 + nameLength + bytes.length, stored.length - 22),
    );
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    const end = Buffer.from(stored.subarray(stored.length - 22));
    end.writeUInt32LE(local.length + packed.length, 16);
    return Buffer.concat([local, packed, central, end]);
  }
  function cache(archive: Buffer, member: Member) {
    const dir = mkdtempSync(join(tmpdir(), "medicare-pbp-pins-"));
    temporary.push(dir);
    const digest = sha(archive);
    const base = join(dir, "raw", "cms-medicare-pbp", digest);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "payload"), archive);
    const url = "https://www.cms.gov/files/zip/synthetic-2026.zip";
    writeFileSync(
      `${base}.meta.json`,
      JSON.stringify({
        url,
        final_url: url,
        sha256: digest,
        bytes: archive.length,
        access_policy: { hosts: [] },
      }),
    );
    const manifest = {
      cacheSource: "cms-medicare-pbp",
      documents: [
        {
          id: "C13",
          url,
          sha256: digest,
          bytes: archive.length,
          contentType: "application/zip",
          members: [member],
        },
      ],
    };
    return { dir, base, manifest };
  }
  const pinned = (name: string, bytes: Buffer): Member => ({
    name,
    sha256: sha(bytes),
    bytes: bytes.length,
    sheet: "Sheet1",
  });

  it("read stored and deflated members", () => {
    expect(zipMember(zip({ "a.xlsx": content }), "a.xlsx")).toEqual(content);
    expect(zipMember(deflatedZip("a.xlsx", content), "a.xlsx")).toEqual(
      content,
    );
    expect(zipMember(zip({ "a.xlsx": content }), "b.xlsx")).toBeNull();
  });

  it("verify a matching member and fail an altered or missing one", async () => {
    const good = cache(
      deflatedZip("a.xlsx", content),
      pinned("a.xlsx", content),
    );
    expect(await pinErrors(good.manifest, good.dir)).toEqual([]);
    expect(await memberPinErrors(good.manifest, good.dir)).toEqual([]);
    const tampered = Buffer.from(content);
    tampered[3] = tampered[3]! ^ 1;
    const altered = cache(
      zip({ "a.xlsx": tampered }),
      pinned("a.xlsx", content),
    );
    expect(
      (await memberPinErrors(altered.manifest, altered.dir)).join(),
    ).toMatch(/a\.xlsx: sha256 [0-9a-f]{64} differs from pin/);
    const missing = cache(
      zip({ "b.xlsx": content }),
      pinned("a.xlsx", content),
    );
    expect(await memberPinErrors(missing.manifest, missing.dir)).toEqual([
      "C13 a.xlsx: not in the archive",
    ]);
  });

  const dataDir = process.env.OPENPLANS_DATA_DIR;
  const cached =
    !!dataDir &&
    pbp.documents.every((doc) =>
      existsSync(join(dataDir, "raw", pbp.cacheSource, doc.sha256, "payload")),
    );
  it.skipIf(!cached)(
    "match the archives and dictionary members in the local cache when present",
    async () => {
      expect(await pinErrors(pbp, dataDir!)).toEqual([]);
      expect(await memberPinErrors(pbp, dataDir!)).toEqual([]);
    },
    120_000,
  );
});
