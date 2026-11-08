import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport, createMcpHandler } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { expect } from 'vitest';
import { buildServer } from '../../src/mcp/server.js';
import type { McpDependencies } from '../../src/mcp/server.js';
import { outputJsonSchemas, outputSchemas } from '../../src/mcp/schemas.js';
import type { ToolName, ToolOutput } from '../../src/mcp/schemas.js';
const validator = new AjvJsonSchemaValidator();

export async function connect(deps: McpDependencies, legacy = false) {
  const server = buildServer(deps), client = new Client({ name: 'openplans-fixture-client', version: '1' }, {
    versionNegotiation: legacy ? { mode: 'legacy' } : { mode: { pin: '2026-07-28' } },
  });
  const messages: string[] = [];
  const handler = createMcpHandler(() => buildServer(deps), { legacy: 'stateless' });
  if (legacy) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(), send = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (message, options) => { messages.push(JSON.stringify(message)); await send(message, options); };
    await server.connect(serverTransport); await client.connect(clientTransport);
  } else {
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), { fetch: async (input, init) => {
      const response = await handler.fetch(new Request(input, init));
      if (response.headers.get('content-type')?.includes('application/json')) messages.push(await response.clone().text());
      return response;
    } });
    await client.connect(transport);
  }
  const called = new Set<ToolName>();
  return { server, client, messages, called,
    async call<T extends ToolName>(tool: T, input: unknown, error = false) {
      const result = await client.callTool({ name: tool, arguments: input as Record<string, unknown> }); called.add(tool);
      expect(Boolean(result.isError), `${tool}: ${JSON.stringify(result.structuredContent)}`).toBe(error);
      const content = result.content[0]; expect(content?.type).toBe('text');
      if (content?.type !== 'text') throw new Error('Missing serialized content');
      expect(JSON.parse(content.text)).toEqual(result.structuredContent);
      const checked = validator.getValidator(outputJsonSchemas[tool])(result.structuredContent);
      expect(checked.valid, `${tool}: ${JSON.stringify(checked)}`).toBe(true);
      return outputSchemas[tool].parse(result.structuredContent) as ToolOutput<T>;
    },
    close: async () => { await client.close(); await server.close(); await handler.close(); },
  };
}
