import { readFile } from 'node:fs/promises';

/** Private policy is supplied by the caller, never bundled with the package. */
export async function loadDenylist(required = false) {
  const file = process.env.OPENPLANS_DENYLIST_FILE;
  if (!file) {
    if (required) throw new Error('OPENPLANS_DENYLIST_FILE is required');
    return null;
  }
  let content;
  try { content = await readFile(file, 'utf8'); }
  catch { throw new Error('Cannot read OPENPLANS_DENYLIST_FILE'); }
  const patterns = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const pattern = line.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    try { patterns.push(new RegExp(pattern, 'i')); }
    catch { throw new Error(`Invalid denylist regex on line ${index + 1}`); }
  }
  if (!patterns.length) throw new Error('Denylist must contain at least one pattern');
  return patterns;
}

/** Decode common literal obfuscations without executing source code. */
export function decodedText(text) {
  const numbers = /\bString\s*\.\s*fromCharCode\s*\(\s*((?:(?:0[xX][\da-fA-F]+|\d+)\s*,\s*)*(?:0[xX][\da-fA-F]+|\d+)\s*,?)\s*\)/g;
  const decoded = text.replace(numbers, (_, args) => args.split(',').filter(value => value.trim())
    .map(value => String.fromCharCode(Number(value.trim()))).join(''));
  const joined = decoded.replace(/\[\s*((?:(?:'[^'\\]*'|"[^"\\]*")\s*,\s*)*(?:'[^'\\]*'|"[^"\\]*")\s*)\]\s*\.join\(\s*(['"])([^'"\\]*)\2\s*\)/g,
    (_, items, _quote, separator) => [...items.matchAll(/'([^']*)'|"([^"]*)"/g)]
      .map(match => match[1] ?? match[2]).join(separator));
  return joined.replace(/\[(.)\]/g, (literal, character) =>
    ['^', '\\', ']'].includes(character) ? literal : character);
}

export function matchesDenylist(text, patterns) {
  const decoded = decodedText(text);
  return patterns.some(pattern => pattern.test(text) || pattern.test(decoded));
}
