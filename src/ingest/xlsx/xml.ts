/** Minimal bounded XML tokenizer for OOXML. No DTD, external entities or entity expansion. */
export type XmlToken = { type: 'open' | 'close'; name: string; attributes: Record<string, string> } | { type: 'text'; text: string };
const invalid = (): never => { throw new Error('invalid_xlsx_xml'); };
function entities(text: string): string {
  return text.replace(/&([^;]*);|&/g, (_entity: string, name: string | undefined) => {
    const builtin: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (name && builtin[name] !== undefined) return builtin[name]!;
    if (!name || !/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(name)) return invalid();
    const point = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return invalid();
    return String.fromCodePoint(point);
  });
}
export async function* xmlTokens(input: AsyncIterable<Uint8Array>, maxTokenBytes = 1024 ** 2): AsyncGenerator<XmlToken> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', ended = false, rootSeen = false;
  const stack: string[] = [];
  const iterator = input[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (!ended && (!pending || (pending[0] === '<' ? !pending.includes('>') : !pending.includes('<')))) {
        const next = await iterator.next();
        ended = !!next.done;
        pending += ended ? decoder.decode() : decoder.decode(next.value, { stream: true });
        if (Buffer.byteLength(pending) > maxTokenBytes + 64 * 1024) throw new Error('xlsx_token_too_large');
      }
      if (!pending) { if (ended) break; continue; }
      if (pending[0] !== '<') {
        const end = pending.indexOf('<');
        if (end < 0 && !ended) continue;
        const text = entities(end < 0 ? pending : pending.slice(0, end));
        pending = end < 0 ? '' : pending.slice(end);
        if (!stack.length && text.trim()) invalid();
        if (text) yield { type: 'text', text };
        continue;
      }
      // XML declarations and comments contain no data. Never accept DTD/entity declarations.
      const comment = pending.startsWith('<!--');
      const declaration = pending.startsWith('<?');
      const terminator = comment ? '-->' : declaration ? '?>' : '>';
      let end = -1;
      if (comment || declaration) end = pending.indexOf(terminator);
      else {
        let quote = '';
        for (let at = 1; at < pending.length; at++) {
          const char = pending[at]!;
          if (quote) { if (char === quote) quote = ''; }
          else if (char === '"' || char === "'") quote = char;
          else if (char === '>') { end = at; break; }
        }
      }
      if (end < 0) {
        if (ended) invalid();
        // Need more bytes even when a quoted attribute/comment contained an earlier `>`.
        const next = await iterator.next(); ended = !!next.done;
        pending += ended ? decoder.decode() : decoder.decode(next.value, { stream: true });
        if (Buffer.byteLength(pending) > maxTokenBytes + 64 * 1024) throw new Error('xlsx_token_too_large');
        continue;
      }
      if (end > maxTokenBytes) throw new Error('xlsx_token_too_large');
      const tag = pending.slice(0, end + terminator.length);
      pending = pending.slice(end + terminator.length);
      if (comment || declaration) continue;
      const match = /^<(\/)?([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(tag);
      if (!match) invalid();
      const [, closing, fullName, rest, selfClosing] = match!;
      const name = fullName!.split(':').at(-1)!;
      if (closing) {
        if (rest!.trim() || selfClosing || stack.pop() !== fullName) invalid();
        yield { type: 'close', name, attributes: {} }; continue;
      }
      if (!stack.length) { if (rootSeen) invalid(); rootSeen = true; }
      if (stack.length >= 64) invalid();
      const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
      let remaining = rest!;
      while (remaining.trim()) {
        const attr = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(remaining);
        if (!attr || Object.hasOwn(attributes, attr[1]!)) invalid();
        attributes[attr![1]!] = entities(attr![2] ?? attr![3]!);
        remaining = remaining.slice(attr![0].length);
      }
      yield { type: 'open', name, attributes };
      if (selfClosing) yield { type: 'close', name, attributes: {} };
      else stack.push(fullName!);
    }
    if (stack.length || !rootSeen) invalid();
  } finally { await iterator.return?.(); }
}
