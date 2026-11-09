/** SYNTHETIC XML/ZIP security fixtures. Regenerate: node tests/fixtures/qhp/generate.mjs */
import { syntheticZip } from "../fetch/generate.mjs";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export function workbook({
  sharedStrings,
  sheet,
  first = "sheet1.xml",
  extra = [],
  stored = true,
}) {
  const entries = [
    {
      name: "xl/workbook.xml",
      body: '<?xml version="1.0"?><workbook xmlns:r="synthetic"><sheets><sheet name="synthetic" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      body: `<Relationships><Relationship Id="rId1" Target="worksheets/${first}" Type="synthetic/worksheet"/></Relationships>`,
    },
    { name: `xl/worksheets/${first}`, body: sheet },
    ...extra,
  ];
  if (sharedStrings !== undefined)
    entries.push({ name: "xl/sharedStrings.xml", body: sharedStrings });
  // Golden bytes must not depend on the platform's zlib implementation.
  return syntheticZip(entries, { stored });
}
export function dishonestZip() {
  const zip = syntheticZip([
    { name: "synthetic-bomb.xml", body: "A".repeat(256 * 1024) },
  ]);
  // Lie consistently in local and central directories. Metadata-only guards see 16 bytes.
  zip.writeUInt32LE(16, 22);
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(16, central + 24);
  return zip;
}
export function dishonestRatioZip() {
  const original = dishonestZip();
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const padding = Buffer.alloc(4096);
  const bytes = Buffer.concat([
    original.subarray(0, central),
    padding,
    original.subarray(central),
  ]);
  bytes.writeUInt32LE(original.readUInt32LE(18) + padding.length, 18);
  bytes.writeUInt32LE(
    original.readUInt32LE(18) + padding.length,
    central + padding.length + 20,
  );
  bytes.writeUInt32LE(central + padding.length, bytes.length - 22 + 16);
  return bytes;
}
export const syntheticWorkbook = ({ stored = true } = {}) =>
  workbook({
    stored,
    sharedStrings:
      "<sst><si><t>State</t></si><si><r><t>Issuer </t></r><r><t>ID</t></r></si><si><t>URL Submitted</t></si><si><t>TX</t></si><si><t>https://synthetic.example/index.json?x=1&amp;y=2</t></si></sst>",
    sheet:
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>76589</v></c><c r="C2" t="s"><v>4</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>A &amp; B &#x1F600;</t></is></c><c r="C3"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
  });
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await writeFile(
    new URL("./synthetic.xlsx.hex", import.meta.url),
    `${syntheticWorkbook().toString("hex")}\n`,
  );
  await writeFile(
    new URL("./dishonest-size.zip.hex", import.meta.url),
    `${dishonestZip().toString("hex")}\n`,
  );
}
