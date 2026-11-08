import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchToCache, FetchError } from '../../fetch/index.js';
import type { FetchOptions, FetchResult, Transport } from '../../fetch/index.js';
export const endpoint = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
export const geographyEndpoint = 'https://geocoding.geo.census.gov/geocoder/geographies/addressbatch';
export const documentation = 'https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html';
export const dataDirectory = () => process.env.OPENPLANS_DATA_DIR ?? join(homedir(), '.local', 'share', 'openplans');
export type BatchFile = Exclude<FetchResult, { outcome: 'not_modified' }>;
export interface CensusOptions { dataDir?: string; sleep?: (ms: number) => Promise<void>; transport?: Transport; lookup?: FetchOptions['lookup']; geographies?: boolean }
export function postTransport(csv: string, geographies = false): Transport {
  const boundary = `------------------------${createHash('sha256').update(csv).digest('hex').slice(0,24)}`;
  const vintage = geographies ? `--${boundary}\r\nContent-Disposition: form-data; name="vintage"\r\n\r\n4\r\n` : '';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="addressFile"; filename="addresses.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\n4\r\n${vintage}--${boundary}--\r\n`);
  return (url, context) => new Promise((resolve,reject) => {
    // Never forward uploaded addresses to a redirected endpoint.
    if (url.href !== (geographies ? geographyEndpoint : endpoint)) { reject(new FetchError('invalid_redirect','Unexpected Census endpoint')); return; }
    const req = request(url, { method: 'POST', family: context.address.family, agent: false,
      headers: { ...context.headers, accept: '*/*', 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
      lookup: (_h,_o,cb) => cb(null,context.address.address,context.address.family), rejectUnauthorized: true });
    const timer = setTimeout(() => req.destroy(new FetchError('connect_timeout','Census connection timed out')), context.connectTimeoutMs);
    req.once('socket', socket => socket.once('secureConnect', () => {
      clearTimeout(timer); req.setTimeout(context.readTimeoutMs, () => req.destroy(new FetchError('read_timeout','Census response timed out')));
    }));
    req.once('response', response => { clearTimeout(timer); response.on('error', () => {}); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }); });
    req.once('error', error => { clearTimeout(timer); reject(error instanceof FetchError ? error : new FetchError('network_error','Census request failed')); });
    req.end(body);
  });
}
export async function acquireBatch(csv: string, options: CensusOptions = {}): Promise<{ file: BatchFile; requests: number }> {
  const records = csv.trimEnd().split('\n').length;
  if (!csv.trim() || records > 10_000) throw new TypeError('Census batch must contain 1–10000 records');
  const target = options.geographies ? geographyEndpoint : endpoint;
  const dataDir = options.dataDir ?? dataDirectory(), requestHash = createHash('sha256').update((options.geographies ? 'Public_AR_Current/Current_Current\n' : 'Public_AR_Current\n') + csv).digest('hex');
  const requestDir = join(dataDir,'raw','census-geocoder-requests');
  const index = join(requestDir,`${requestHash}.json`);
  let sha256: string | undefined;
  try { sha256 = (JSON.parse(await readFile(index,'utf8')) as { sha256: string }).sha256; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let requests = 0;
  const transport = options.transport ?? postTransport(csv,options.geographies);
  const file = await fetchToCache(target, { source: 'census-geocoder-batch', allowHosts: ['geocoding.geo.census.gov'],
    expectedContent: 'csv', dataDir, expectedSha256: sha256, maxBytes: 16 * 1024 ** 2, maxRedirects: 0,
    readTimeoutMs: 180_000, maxAttempts: 3, maxRetryDelayMs: 60_000, sleep: options.sleep, lookup: options.lookup,
    transport: async (url,context) => { requests++; return transport(url,context); } });
  if (file.outcome === 'not_modified') throw new Error('Unexpected Census conditional response');
  await mkdir(requestDir,{ recursive: true });
  // Input is retained with the request identity; raw response bytes are content addressed by fetchToCache.
  await writeFile(join(requestDir,`${requestHash}.csv`),csv,{ flag: 'w' });
  const temp = `${index}.${process.pid}.part`;
  await writeFile(temp,JSON.stringify({ requestHash, benchmark: 'Public_AR_Current', vintage: options.geographies ? 'Current_Current' : null, sha256: file.metadata.sha256, records }));
  await rename(temp,index);
  return { file, requests };
}
