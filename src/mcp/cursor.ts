import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class ToolError extends Error {
  constructor(readonly code: string, readonly field: string | null = null) { super(code); }
}

// Shared by request-scoped factories in one process. Multi-process hosts inject the same key.
const processKey = randomBytes(32);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export interface CursorBinding { tool: string; filters: unknown; generation: string; scope: string }
export function cursorCodec(key: string | Uint8Array = processKey, now: () => number = Date.now) {
  const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url');
  const mac = (value: string) => createHmac('sha256', key).update(value).digest();
  return {
    issue(binding: CursorBinding, offset: number) {
      const payload = Buffer.from(JSON.stringify({ v: 1, tool: binding.tool, filter: digest(binding.filters),
        generation: binding.generation, scope: digest(binding.scope), offset, expires: now() + 15 * 60_000 })).toString('base64url');
      return `${payload}.${mac(payload).toString('base64url')}`;
    },
    read(token: string | undefined, binding: CursorBinding): number {
      if (token === undefined) return 0;
      try {
        if (token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token)) throw new ToolError('INVALID_CURSOR');
        const [payload, signature] = token.split('.') as [string, string];
        const actual = Buffer.from(signature, 'base64url'), expected = mac(payload);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
          || actual.toString('base64url') !== signature) throw new ToolError('INVALID_CURSOR');
        const row = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
        if (row.v !== 1 || row.tool !== binding.tool || row.filter !== digest(binding.filters) || row.scope !== digest(binding.scope)
          || !Number.isSafeInteger(row.offset) || Number(row.offset) < 0 || typeof row.expires !== 'number') throw new ToolError('INVALID_CURSOR');
        if (row.generation !== binding.generation || row.expires <= now()) throw new ToolError('CURSOR_EXPIRED');
        return Number(row.offset);
      } catch (error) { if (error instanceof ToolError) throw error; throw new ToolError('INVALID_CURSOR'); }
    },
  };
}
