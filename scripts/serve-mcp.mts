/**
 * `cortex serve` — the local CORTEX MCP server on stdio. spec/05-INTERFACES.md §2.
 *
 * This is what coding agents attach to. The CLI that wraps it is U2's business; this
 * is the entry point it will call.
 *
 * Diagnostics go to stderr on purpose. On stdio, stdout carries the JSON-RPC frames,
 * so anything else printed there is a parse error at the client rather than a log.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from '../src/mcp/server.js';

// Resolved against this file, not the working directory. An agent launches its MCP
// servers from wherever it happens to be running, and until U8 gave the server a
// handler nothing here read the environment, so the omission could not show up.
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const server = createServer();

await server.connect(new StdioServerTransport());

process.stderr.write('cortex mcp server listening on stdio\n');
