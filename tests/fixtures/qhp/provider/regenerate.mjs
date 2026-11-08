import { homedir } from 'node:os';
/** Build first. Selects exact public Cigna records, omitting contact/email fields only. */
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const tarPath = process.env.ISSUER_TAR;
if (!tarPath) {
 console.error('Usage: ISSUER_TAR=/path/to/issuer-files.tar node tests/fixtures/qhp/provider/regenerate.mjs');
 process.exit(1);
}
const { readJsonArray } = await import('../../../../dist/ingest/json/index.js');
const cache = process.env.OPENPLANS_DATA_DIR ?? join(homedir(), '.local', 'share', 'openplans');
const out = dirname(fileURLToPath(import.meta.url));
const dir = join(cache,'raw/qhp-76589-2026-provider_urls');
const names = (await readdir(dir)).filter(n => n.endsWith('.meta.json'));
if (names.length !== 1) throw new Error('Select an unambiguous cached provider version');
const metadata = JSON.parse(await readFile(join(dir,names[0]),'utf8'));
const selected = [], indexes = [], hash = createHash('sha256');
async function* bytes() { for await (const b of createReadStream(join(dir,metadata.snapshot_id,'payload'))) { hash.update(b); yield b; } }
let row = 0;
for await (const r of readJsonArray(bytes())) {
 const tx = r.plans?.some(p => p.plan_id?.startsWith('76589TX'));
 const needs = tx && (r.type === 'GROUP' && !selected.some(p => p.type === 'GROUP')
   || r.type === 'FACILITY' && !selected.some(p => p.type === 'FACILITY')
   || r.type === 'INDIVIDUAL' && selected.filter(p => p.type === 'INDIVIDUAL').length < 3
   || r.addresses?.length > 1 && !selected.some(p => p.addresses.length > 1)
   || r.plans.some(p => !p.plan_id.startsWith('76589TX')) && !selected.some(p => p.plans.some(p => !p.plan_id.startsWith('76589TX'))));
 if (needs) {
  selected.push(Object.fromEntries(['npi','type','plans','name','facility_name','facility_type','group_name','addresses','speciality','specialty','languages','accepting','last_updated_on']
   .filter(k => r[k] !== undefined).map(k => [k,r[k]]))); indexes.push(row);
 }
 row++;
}
if (hash.digest('hex') !== metadata.sha256 || !selected.some(r => r.type === 'FACILITY')
 || !selected.some(r => r.addresses.length > 1)) throw new Error('Cigna cut/hash failed');
// Seek over all unrelated tar members; read only this member's last 4096 bytes.
const tar = await open(tarPath,'r');
let at = 0, tail, sanford;
try {
 for (;;) {
  const header = Buffer.alloc(512); const { bytesRead } = await tar.read(header,0,512,at);
  if (bytesRead < 512 || header.every(b => !b)) break;
  const name = header.subarray(0,100).toString().replace(/\0.*$/s,'');
  const prefix = header.subarray(345,500).toString().replace(/\0.*$/s,'');
  const member = prefix ? `${prefix}/${name}` : name;
  const size = parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8);
  if (member === 'files/issuer-files/tools.sanfordhealthplan.com/40f355cb43db-JSON_Providers_SANHP_HIX.json') {
   tail = Buffer.alloc(Math.min(4096,size)); await tar.read(tail,0,tail.length,at+512+size-tail.length);
   sanford = { member,member_bytes: size,tail_offset: size-tail.length,tail_bytes: tail.length,tail_sha256: createHash('sha256').update(tail).digest('hex') }; break;
  }
  at += 512+Math.ceil(size/512)*512;
 }
} finally { await tar.close(); }
if (!tail) throw new Error('Sanford member missing');
// First complete plan association inside the real tail, followed by its original cut EOF.
// No provider/name/NPI is invented: this fixture exercises stream completeness before record validation.
const text = tail.toString('utf8'); const start = text.indexOf('{\r\n        "plan_id_type"');
if (start < 0 || !text.trimEnd().endsWith(',')) throw new Error('Unexpected Sanford truncation shape');
const truncated = '[\n'+text.slice(start).replace(/\r\n/g,'\n');
const planDir = join(cache,'raw/qhp-76589-2026-plan_urls');
const planName = (await readdir(planDir)).find(n => n.endsWith('.meta.json'));
const pm = JSON.parse(await readFile(join(planDir,planName),'utf8'));
const definitions = [];
for await (const p of readJsonArray(createReadStream(join(planDir,pm.snapshot_id,'payload')))) {
 if (p.plan_id.startsWith('76589TX')) definitions.push({ plan_id: p.plan_id,plan_id_type: p.plan_id_type,years: p.years,network: p.network });
}
const files = { 'records.json': JSON.stringify(selected,null,2)+'\n','plans.json': JSON.stringify(definitions,null,2)+'\n',
 'sanford-tail.json': truncated,'provenance.json': JSON.stringify({ synthetic: false,cigna: { ...metadata,source_record_indexes: indexes,total_records: row },
 sanford: { ...sanford,projection: 'prepend [ and begin at first complete association in last 4096 bytes; original EOF retained; CRLF normalized to LF' },
 note: 'Whitelisted published fields only; no email fields. All source addresses and plan associations of selected records retained.' },null,2)+'\n' };
for (const [name,data] of Object.entries(files)) {
 if (Buffer.byteLength(data) >= 200000) throw new Error('Oversize fixture '+name);
 await writeFile(join(out,name),data);
}
console.log(JSON.stringify({ source_records: row,selected: indexes,bytes: metadata.bytes,sha256: metadata.sha256,sanford }));
