import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inspectZip, streamZipMember } from "../../fetch/index.js";
import { readXlsxRows } from "../xlsx/index.js";
import { rows } from "./parse.js";
import { dataDirectory, zipLimits } from "./acquire.js";
import type { Kind } from "./acquire.js";
export type Input =
  | {
      main(): AsyncIterable<Uint8Array | string>;
      secondary(): AsyncIterable<Uint8Array | string>;
    }
  | { deactivations(): AsyncIterable<string[]> };

export async function archiveInput(
  path: string,
  kind: Kind,
): Promise<{ input: Input; dataDate: string }> {
  const members = (await inspectZip(path, zipLimits)).members;
  if (kind === "deactivation") {
    const member = members.find((m) => /deactivated.*\.xlsx$/i.test(m.name));
    const match = /\b(\d{4})(\d{2})(\d{2})\.xlsx$/i.exec(member?.name ?? "");
    if (!member || !match) throw new Error("Missing V2 deactivation workbook");
    return {
      dataDate: `${match[1]}-${match[2]}-${match[3]}`,
      input: {
        async *deactivations() {
          const root = join(dataDirectory(), "work");
          await mkdir(root, { recursive: true });
          const directory = await mkdtemp(join(root, "nppes-xlsx-"));
          try {
            const target = join(directory, "deactivations.xlsx");
            await pipeline(
              Readable.from(streamZipMember(path, member.name, zipLimits)),
              createWriteStream(target, { flags: "wx" }),
            );
            let foundHeader = false;
            for await (const row of readXlsxRows(target, {
              maxRows: 2_000_000,
              maxSharedStrings: 2_000_000,
              maxUncompressedBytes: 256 * 1024 ** 2,
            })) {
              if (!foundHeader) {
                if (row[0] === "NPI" && row[1] === "NPPES Deactivation Date")
                  foundHeader = true;
                continue;
              }
              yield row;
            }
            if (!foundHeader)
              throw new Error("Invalid NPPES deactivation header");
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        },
      },
    };
  }
  const main = members.find((m) =>
    /(?:^|\/)npidata_pfile_\d{8}-\d{8}\.csv$/i.test(m.name),
  );
  const secondary = members.find((m) =>
    /(?:^|\/)pl_pfile_\d{8}-\d{8}\.csv$/i.test(m.name),
  );
  const match = /-(\d{4})(\d{2})(\d{2})\.csv$/i.exec(main?.name ?? "");
  if (
    !main ||
    !secondary ||
    !match ||
    !members.some((m) => /readme.*v[._]?2\.pdf$/i.test(m.name))
  ) {
    throw new Error(
      "Wrong NPPES version: V2 bundle with secondary practice file and V2 readme required",
    );
  }
  return {
    dataDate: `${match[1]}-${match[2]}-${match[3]}`,
    input: {
      main: () => streamZipMember(path, main.name, zipLimits),
      secondary: () => streamZipMember(path, secondary.name, zipLimits),
    },
  };
}
/** Fixture adapter for cuts of the public XLSX report, saved as CSV. */
export async function* deactivationCsv(
  input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string[]> {
  for await (const row of rows(input, ["NPI", "NPPES Deactivation Date"]))
    yield [row.get("NPI"), row.get("NPPES Deactivation Date")];
}
