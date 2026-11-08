import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Database } from '../../db/database.js';
import type { Address } from './address.js';
import { batchCsv, addressIdentity } from './address.js';
import { acquireBatch } from './census.js';
import type { BatchFile, CensusOptions } from './census.js';
import { parseBatch } from './parse.js';
import { addresses, addressCursor, reused, saveSnapshot, snapshotId, saveResult, issue } from './repository.js';
import type { Selection } from './repository.js';
export interface GeocodeOptions extends Selection, CensusOptions {
  batchSize?: number; progress?: (message: string) => void;
  acquire?: (csv: string) => Promise<{ file: BatchFile; requests: number }>;
}
export async function ingestGeocode(db: Database, options: GeocodeOptions = {}) {
  if ((options.county && !/^48\d{3}$/.test(options.county)) || (options.zips && (!options.zips.length || options.zips.some(z=>!/^\d{5}$/.test(z))))) throw new TypeError('Invalid TX county or ZIP filter');
  const batchSize = options.batchSize ?? 10_000;
  if (!Number.isInteger(batchSize) || batchSize<1 || batchSize>10_000) throw new TypeError('Batch size must be 1–10000');
  const started = Date.now(), report = { selected: 0, reused: 0, addressesSent: 0, exact: 0, nonExact: 0, tie: 0,
    unmatched: 0, centroidFallbacks: 0, noPoint: 0, issues: 0, requests: 0, batches: 0, elapsedSeconds: 0,
    countySelection: options.county ? 'ZIPs intersecting county (ZCTA relationship)' : null };
  let after = '';
  for (;;) {
    const page = await addresses(db,options,after,batchSize);
    if (!page.length) break;
    after = addressCursor(page[page.length-1]!);
    const pending: Address[] = [], duplicates: Address[] = [];
    const hashes = new Set<string>();
    for (const address of page) {
      report.selected++;
      if (await reused(db,address)) report.reused++;
      else {
        const hash = addressIdentity(address).hash;
        if (hashes.has(hash)) duplicates.push(address);
        else { hashes.add(hash); pending.push(address); }
      }
    }
    if (!pending.length) continue;
    if (report.batches) await (options.sleep ?? (ms=>new Promise(resolve=>setTimeout(resolve,ms))))(1000);
    const acquired = await (options.acquire ?? (csv=>acquireBatch(csv,options)))(batchCsv(pending));
    report.addressesSent += pending.length; report.requests += acquired.requests; report.batches++;
    const raw = await readFile(acquired.file.path);
    if (createHash('sha256').update(raw).digest('hex') !== acquired.file.metadata.sha256) throw new Error('Census snapshot hash mismatch');
    const parsed = await parseBatch(raw.toString('utf8')), snapshot = snapshotId(acquired.file);
    await db.transaction(async tx => {
      await saveSnapshot(tx,acquired.file);
      for (const problem of parsed.issues) { report.issues++; await issue(tx,snapshot,`line:${problem.line}`,problem.code); }
      for (const [i,address] of pending.entries()) {
        const row = parsed.rows.get(String(i+1));
        if (!row) { report.issues++; await issue(tx,snapshot,String(i+1),'missing_or_invalid_row'); }
        else if (row.status==='Tie') report.tie++;
        else if (row.status==='No_Match') report.unmatched++;
        else if (row.quality==='Exact') report.exact++; else report.nonExact++;
        const method = await saveResult(tx,address,row,snapshot);
        if (method==='zcta_centroid') report.centroidFallbacks++;
        if (method==='no_point' || method==='issue') report.noPoint++;
      }
      for (const address of duplicates) {
        if (await reused(tx,address)) report.reused++;
        else { report.issues++; report.noPoint++; await saveResult(tx,address,undefined,snapshot); }
      }
      for (const id of parsed.rows.keys()) if (Number(id)>pending.length) { report.issues++; await issue(tx,snapshot,id,'unexpected_row'); }
      await tx.query(`UPDATE snapshot SET validation_state='ACTIVE',activated_at=COALESCE(activated_at,now()) WHERE snapshot_id=$1`,[snapshot]);
    });
    report.elapsedSeconds=(Date.now()-started)/1000; options.progress?.(JSON.stringify(report));
  }
  if (report.selected) await db.exec('ANALYZE geocode_attempt; ANALYZE address_point');
  report.elapsedSeconds=(Date.now()-started)/1000;
  return report;
}
