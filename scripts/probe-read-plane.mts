/**
 * Invokes the read plane and reports what it can actually do. U10's "verify live
 * first"; spec/04-ARCHITECTURE.md §2, spec/03-MEMORY-MODEL.md §4.1.
 *
 *   npm run probe:read
 *
 * Two independent paths are checked, because `04` §2 assumes things about both:
 *
 * 1. **`CORTEX_READER_DSN`** — a direct connection as `cortex_reader`. The claim is
 *    that this principal can read and cannot write. V9 found the opposite once
 *    already, from an `admin` membership that no table-level `SHOW GRANTS` revealed,
 *    so the check here is to *attempt a write and be refused*. A grant table is not
 *    an answer to "can this principal write".
 *
 * 2. **The CockroachDB Cloud Managed MCP Server** — the path `04` §2 routes agent
 *    reads through, on the argument that access is then governed by Cloud RBAC
 *    rather than by code in this repository. Its tool list is printed in full and
 *    the write tools are called out, because "read plane" has to be a property of
 *    something: the server publishes `insert_rows`, `create_table` and
 *    `create_database`, so it is not a property of the server.
 *
 * Prints no credential. The API key and both DSNs are read from `.env` and never
 * echoed; failures are reported by message, and provider messages are quoted as-is,
 * so do not add a mode that dumps request headers.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client as PgClient } from 'pg';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

/** A 1024-wide zero vector, so the probe INSERT is well typed if it is ever allowed. */
const ZERO_VECTOR = `[${Array(1024).fill(0).join(',')}]`;

function heading(text: string): void {
  console.log(`\n=== ${text} ===`);
}

async function probeReaderDsn(): Promise<void> {
  heading('CORTEX_READER_DSN — direct connection');

  const dsn = process.env.CORTEX_READER_DSN;
  if (!dsn) {
    console.log('not set. The read-plane principal has no connection string in .env.');
    return;
  }

  const client = new PgClient({ connectionString: dsn });
  try {
    await client.connect();
  } catch (error) {
    console.log(`connect failed: ${(error as Error).message}`);
    return;
  }

  try {
    const { rows } = await client.query('SELECT current_user AS who');
    console.log(`connected as: ${(rows[0] as { who: string }).who}`);

    const checks: Array<[string, string]> = [
      ['SELECT findings', 'SELECT count(*) AS n FROM findings'],
      [
        'INSERT findings',
        `INSERT INTO findings (repo_id, fact, embedding) VALUES (gen_random_uuid(), 'probe', '${ZERO_VECTOR}')`,
      ],
      ['UPDATE claims', "UPDATE claims SET holder = 'probe' WHERE resource_key = 'file:nothing'"],
      ['DROP TABLE findings', 'DROP TABLE findings'],
    ];

    for (const [label, sql] of checks) {
      try {
        await client.query(sql);
        const verdict = label.startsWith('SELECT') ? 'ALLOWED' : 'ALLOWED  <-- NOT read-only';
        console.log(`  ${label.padEnd(20)} ${verdict}`);
      } catch (error) {
        console.log(`  ${label.padEnd(20)} refused — ${(error as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function probeManagedMcp(): Promise<void> {
  heading('CockroachDB Cloud Managed MCP Server');

  const endpoint = process.env.CORTEX_MCP_ENDPOINT;
  const clusterId = process.env.CORTEX_MCP_CLUSTER_ID;
  const apiKey = process.env.CORTEX_MCP_API_KEY;

  for (const [name, value] of [
    ['CORTEX_MCP_ENDPOINT', endpoint],
    ['CORTEX_MCP_CLUSTER_ID', clusterId],
    ['CORTEX_MCP_API_KEY', apiKey],
  ] as const) {
    if (!value) {
      console.log(`${name} is not set; cannot reach the managed server.`);
      return;
    }
  }

  console.log(`endpoint: ${endpoint}`);
  console.log(`cluster:  ${clusterId}`);

  const mcp = new McpClient({ name: 'cortex-read-plane-probe', version: '0.1.0' });

  const transport = new StreamableHTTPClientTransport(new URL(endpoint!), {
    requestInit: {
      headers: { 'mcp-cluster-id': clusterId!, Authorization: `Bearer ${apiKey!}` },
    },
  });

  try {
    // The SDK's `Transport` interface declares `sessionId?: string`, while this
    // transport implements it as a getter returning `string | undefined`. Under
    // `exactOptionalPropertyTypes` those are different types; at runtime they are the
    // same absent value. Narrowed at the call site rather than by relaxing tsconfig —
    // B1 established that `npx tsc --noEmit` staying clean is the constraint, and
    // that the fix belongs at the use, not in the compiler options.
    await mcp.connect(transport as unknown as Parameters<McpClient['connect']>[0]);
  } catch (error) {
    console.log(`connect failed: ${(error as Error).message}`);
    return;
  }

  const { tools } = await mcp.listTools();
  // §3's split puts writes on our server and reads on this one. This server does not
  // observe that split, so name the tools that cross it rather than summarising.
  const WRITE_TOOLS = ['insert_rows', 'create_table', 'create_database'];
  console.log(`\ntools advertised (${tools.length}):`);
  for (const tool of tools) {
    const mark = WRITE_TOOLS.includes(tool.name) ? '  <-- WRITE' : '';
    console.log(`  ${tool.name}${mark}`);
  }

  console.log('\nwhat this principal can actually do:');
  const calls: Array<[string, string, Record<string, unknown>]> = [
    ['list_clusters', 'list_clusters', {}],
    ['get_cluster', 'get_cluster', {}],
    ['list_databases', 'list_databases', {}],
    ['select_query (identity)', 'select_query', {
      database: 'defaultdb',
      query: 'SELECT current_user AS who',
    }],
    ['select_query (recall shape)', 'select_query', {
      database: 'defaultdb',
      query: "SELECT count(*) AS n FROM findings WHERE repo_id = '00000000-0000-0000-0000-000000000000'",
    }],
    // Aimed at a table that does not exist on purpose: a permission failure and a
    // missing-table failure are then distinguishable, and a real table is never
    // written to whatever the answer turns out to be.
    ['insert_rows (write reach)', 'insert_rows', {
      database: 'defaultdb',
      query: "INSERT INTO cortex_probe_does_not_exist (k) VALUES ('x')",
    }],
  ];

  for (const [label, name, args] of calls) {
    try {
      const result = (await mcp.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      const text = (result.content ?? [])
        .map((part) => part.text ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 160);
      console.log(`  ${label.padEnd(28)} OK      ${text}`);
    } catch (error) {
      console.log(`  ${label.padEnd(28)} FAILED  ${(error as Error).message.slice(0, 160)}`);
    }
  }

  await mcp.close();
}

await probeReaderDsn();
await probeManagedMcp();

console.log('\nRead the write-tool lines and the write-reach line together: a read plane');
console.log('has to be a property of the principal, because it is not one of the server.');

process.exit(0);
