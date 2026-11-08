import { posix } from 'node:path';
import { inspectZip, streamZipMember } from '../../fetch/index.js';
import type { ZipLimits } from '../../fetch/index.js';
import { xmlTokens } from './xml.js';

export interface XlsxLimits extends ZipLimits {
  maxSharedStrings?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCellBytes?: number;
}
const invalid = (): never => { throw new Error('invalid_xlsx'); };

/** Minimal OOXML reader: first workbook worksheet, shared/inline strings and raw cached values.
 * No formula evaluation, styles, date conversion or implicit numeric ID conversion. */
export async function* readXlsxRows(path: string, options: XlsxLimits = {}): AsyncGenerator<string[]> {
  const limits = { maxUncompressedBytes: 32 * 1024 ** 2, ...options };
  const maxStrings = options.maxSharedStrings ?? 100_000, maxRows = options.maxRows ?? 100_000;
  const maxColumns = options.maxColumns ?? 1024, maxCell = options.maxCellBytes ?? 1024 ** 2;
  if (![maxStrings, maxRows, maxColumns, maxCell].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Invalid XLSX limits');
  const members = (await inspectZip(path, limits)).members;
  let relationship: string | undefined;
  for await (const token of xmlTokens(streamZipMember(path, 'xl/workbook.xml', limits))) {
    if (token.type === 'open' && token.name === 'sheet' && !relationship) relationship = token.attributes['r:id'];
  }
  if (!relationship) invalid();
  let worksheet: string | undefined;
  for await (const token of xmlTokens(streamZipMember(path, 'xl/_rels/workbook.xml.rels', limits))) {
    if (token.type === 'open' && token.name === 'Relationship' && token.attributes.Id === relationship) {
      const target = token.attributes.Target;
      if (!target || token.attributes.TargetMode === 'External' || target.includes('\\')
        || !token.attributes.Type?.endsWith('/worksheet')) invalid();
      worksheet = posix.normalize(target!.startsWith('/') ? target!.slice(1) : posix.join('xl', target!));
      if (!worksheet.startsWith('xl/worksheets/')) invalid();
    }
  }
  if (!worksheet) invalid();
  const strings: string[] = [];
  if (members.some(member => member.name === 'xl/sharedStrings.xml')) {
    let text: string | undefined, inText = false;
    for await (const token of xmlTokens(streamZipMember(path, 'xl/sharedStrings.xml', limits), maxCell)) {
      if (token.type === 'open' && token.name === 'si') text = '';
      else if (token.type === 'open' && token.name === 't') inText = true;
      else if (token.type === 'close' && token.name === 't') inText = false;
      else if (token.type === 'text' && inText && text !== undefined) {
        text += token.text; if (Buffer.byteLength(text) > maxCell) throw new Error('xlsx_cell_too_large');
      } else if (token.type === 'close' && token.name === 'si') {
        if (text === undefined) invalid();
        if (strings.length >= maxStrings) throw new Error('xlsx_too_many_strings');
        strings.push(text!); text = undefined;
      }
    }
  }
  let row: string[] | undefined, cell: { column: number; type: string; value: string } | undefined;
  let inValue = false, rowCount = 0;
  for await (const token of xmlTokens(streamZipMember(path, worksheet!, limits), maxCell)) {
    if (token.type === 'open' && token.name === 'row') {
      if (row || ++rowCount > maxRows) throw new Error('xlsx_row_limit');
      row = [];
    } else if (token.type === 'open' && token.name === 'c') {
      if (!row || cell) invalid();
      const reference = /^([A-Z]+)[1-9][0-9]*$/.exec(token.attributes.r ?? '');
      let column = row!.length;
      if (reference) { column = 0; for (const char of reference[1]!) column = column * 26 + char.charCodeAt(0) - 64; column--; }
      if (column < row!.length || column >= maxColumns) invalid();
      cell = { column, type: token.attributes.t ?? '', value: '' };
    } else if (token.type === 'open' && (token.name === 'v' || token.name === 't')) inValue = true;
    else if (token.type === 'close' && (token.name === 'v' || token.name === 't')) inValue = false;
    else if (token.type === 'text' && cell && inValue) {
      cell.value += token.text;
      if (Buffer.byteLength(cell.value) > maxCell) throw new Error('xlsx_cell_too_large');
    } else if (token.type === 'close' && token.name === 'c') {
      if (!cell || !row) invalid();
      while (row!.length < cell!.column) row!.push('');
      let text = cell!.value;
      if (cell!.type === 's') {
        if (!/^\d+$/.test(text) || strings[Number(text)] === undefined) invalid();
        text = strings[Number(text)]!;
      }
      row!.push(text); cell = undefined;
    } else if (token.type === 'close' && token.name === 'row') {
      if (!row || cell) invalid();
      yield row!; row = undefined;
    }
  }
}
