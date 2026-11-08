// Reproducible unmodified source cuts; requires a previously acquired cached US.zip, never downloads.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cachedHash, dataDirectory } from '../../../dist/ingest/geo/sources.js';
import { GEONAMES_SOURCE, GEONAMES_URL } from '../../../dist/ingest/geo/geonames.js';
import { streamZipMember } from '../../../dist/fetch/index.js';
const dir = dataDirectory(), hash = await cachedHash(dir, GEONAMES_SOURCE, GEONAMES_URL);
if (!hash) throw new Error('Acquire GeoNames into OPENPLANS_DATA_DIR before regenerating');
const root = join(dir,'raw',GEONAMES_SOURCE), path = join(root,hash,'payload');
const metadata = JSON.parse(await readFile(join(root,`${hash}.meta.json`),'utf8'));
if (createHash('sha256').update(await readFile(path)).digest('hex') !== hash) throw new Error('Source hash mismatch');
const chunks=[];
for await (const chunk of streamZipMember(path,'US.txt',{maxMembers:5,maxUncompressedBytes:20*1024**2})) chunks.push(chunk);
const selected = new Set(['01001','75034','77001','77002','85001']);
const lines = Buffer.concat(chunks).toString('utf8').split('\n');
const cut=[], sourceRows=[];
for (let i=0;i<lines.length;i++) if(selected.has(lines[i].split('\t')[1])) {cut.push(lines[i]);sourceRows.push(i+1);}
if(new Set(cut.map(line=>line.split('\t')[1])).size!==selected.size) throw new Error('Missing required ZIP');
const data=Buffer.from(cut.join('\n')+'\n');
await writeFile(new URL('geonames-us-cut.tsv',import.meta.url),data);
await writeFile(new URL('geonames-manifest.json',import.meta.url),JSON.stringify({
  description:'Unmodified real GeoNames US postal-code rows, selected by exact ZIP; no coordinates used.',
  filename:'geonames-us-cut.tsv',source_rows:sourceRows,original_snapshot:metadata,
  fixture_sha256:createHash('sha256').update(data).digest('hex'),
  attribution:{publisher:'GeoNames',url:'https://www.geonames.org/',license:'CC BY 4.0',license_url:'https://creativecommons.org/licenses/by/4.0/'},
},null,2)+'\n');
