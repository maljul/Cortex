/**
 * `cortex serve` — the local CORTEX MCP server on stdio. spec/05-INTERFACES.md §2.
 *
 * This is what coding agents attach to. The CLI that wraps it is U2's business; this
 * is the entry point it will call.
 *
 * Diagnostics go to stderr on purpose. On stdio, stdout carries the JSON-RPC frames,
 * so anything else printed there is a parse error at the client rather than a log.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from '../src/mcp/server';

const server = createServer();

await server.connect(new StdioServerTransport());

process.stderr.write('cortex mcp server listening on stdio\n');
