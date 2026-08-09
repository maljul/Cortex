/**
 * U7 — the CORTEX MCP server skeleton, over a real stdio transport.
 *
 * `docs/UNITS.md` U7 is done when "a client lists the three write tools over stdio
 * and gets the schemas from `05` §3 verbatim". Two of those words carry the unit:
 *
 * - **a client** — so the listing tests spawn `scripts/serve-mcp.mts` as a child
 *   process and speak MCP to it over pipes. Nothing here imports the server module
 *   into the test process, because an in-process handler call would prove the
 *   handler runs and say nothing about whether the transport works.
 * - **verbatim** — so the schema tests parse the JSON blocks out of
 *   `spec/05-INTERFACES.md` §3 at run time and deep-compare. A copy checked against
 *   another copy drifts silently; a copy checked against the spec cannot.
 *
 * Invariants at risk, per CLAUDE.md and `spec/03-MEMORY-MODEL.md` §8:
 *
 * - **7** — no agent-reachable path accepts SQL, a table name, or any structural
 *   parameter. The tool `inputSchema` is the agent-reachable path, so its property
 *   set is pinned exactly and a denylist sweeps the whole surface at any depth.
 * - **8** — no credential field on any demo surface, under any name, including
 *   commented out. Swept over the served tool JSON *and* over the source text of
 *   `src/mcp/`, since a commented-out field never reaches the wire.
 * - **3 and 4** — `blocked` and `deduped` are results, not errors. U7 implements no
 *   handler, so the test here is the negative one: the skeleton must not have grown
 *   an arbitration path that would decide those without U8's transaction.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORTEX_TOOLS, TOOL_NAMES } from '../src/mcp/tools.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The JSON blocks the spec publishes under §3, keyed by tool name.
 *
 * Deliberately re-derived from the markdown on every run rather than snapshotted.
 * `05` §3 calls the `description` strings "prompt surface, not documentation" — an
 * editor who reworded one and a server that kept the old wording is exactly the
 * drift this unit's silent break describes, and only reading the live file catches it.
 */
function schemasPublishedInSpec(): Map<string, Record<string, unknown>> {
  const spec = readFileSync(new URL('../spec/05-INTERFACES.md', import.meta.url), 'utf8');

  const start = spec.indexOf('## 3. CORTEX MCP server');
  const end = spec.indexOf('## 4. Agent Skill');
  expect(start, 'spec/05-INTERFACES.md §3 heading').toBeGreaterThan(-1);
  expect(end, 'spec/05-INTERFACES.md §4 heading').toBeGreaterThan(start);

  const section = spec.slice(start, end);
  const blocks = section.matchAll(/```json\n([\s\S]*?)```/g);

  const published = new Map<string, Record<string, unknown>>();
  for (const [, body] of blocks) {
    const parsed = JSON.parse(body as string) as { name: string };
    published.set(parsed.name, parsed as unknown as Record<string, unknown>);
  }
  return published;
}

/**
 * Names that would make a tool call structural (invariant 7) or credential-bearing
 * (invariant 8), applied only to fields the spec did not itself publish.
 *
 * The exemption matters: `tokens_spent` is `05` §3's own field and means LLM tokens,
 * not a bearer token. Sweeping it would force either a weaker pattern or an edit to
 * the spec's schema, and the spec's schema is the contract — it is pinned verbatim
 * by the test above. What this pattern guards is everything we might *add*.
 */
const FORBIDDEN_FIELD = new RegExp(
  [
    // invariant 7 — structural
    'sql', 'table', 'column', 'schema_name', 'where', 'filter', 'order_?by',
    'query', 'raw', 'stmt', 'exec', 'view', 'index_name', 'dsn',
    // invariant 8 — credential
    'password', 'passwd', 'secret', 'token', 'credential', 'api_?key',
    'connection_?string', 'conn_?str', 'auth', 'session_?key', 'access_?key',
  ].join('|'),
  'i',
);

/** Property names `05` §3 publishes, which the sweep above does not apply to. */
function fieldsPublishedInSpec(): Set<string> {
  const names = new Set<string>();
  for (const block of schemasPublishedInSpec().values()) {
    for (const name of propertyNames(block)) names.add(name);
  }
  return names;
}

/** Every property name appearing anywhere in a JSON Schema, at any depth. */
function propertyNames(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return found;

  if (Array.isArray(node)) {
    for (const item of node) propertyNames(item, found);
    return found;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      found.push(...Object.keys(value));
    }
    propertyNames(value, found);
  }
  return found;
}

describe('tool definitions against spec/05-INTERFACES.md §3', () => {
  it('publishes exactly the three write tools, in spec order', () => {
    expect(TOOL_NAMES).toEqual(['cortex_propose', 'cortex_close', 'cortex_heartbeat']);
    expect(CORTEX_TOOLS.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it('reproduces the propose and close blocks verbatim, description included', () => {
    const published = schemasPublishedInSpec();

    // §3 gives a JSON block for two of the three. If a third ever lands in the spec,
    // this assertion fails and the heartbeat test below has to stop deriving.
    expect([...published.keys()]).toEqual(['cortex_propose', 'cortex_close']);

    for (const [name, block] of published) {
      const served = CORTEX_TOOLS.find((tool) => tool.name === name);
      expect(served, `${name} is served`).toBeDefined();
      expect(served).toEqual(block);
    }
  });

  it('derives heartbeat from the §1 signature, since §3 gives it no block', () => {
    const heartbeat = CORTEX_TOOLS.find((tool) => tool.name === 'cortex_heartbeat');
    expect(heartbeat).toBeDefined();

    // `05` §1: heartbeat(repo, intentId, extendBy?). Three fields, two required.
    const properties = heartbeat!.inputSchema.properties;
    expect(Object.keys(properties!).sort()).toEqual(['extend_by', 'intent_id', 'repo']);
    expect(heartbeat!.inputSchema.required).toEqual(['repo', 'intent_id']);
  });
});

describe('invariant 7 — nothing structural crosses the tool boundary', () => {
  it('declares no property beyond the spec whose name is structural', () => {
    const published = fieldsPublishedInSpec();

    for (const tool of CORTEX_TOOLS) {
      for (const name of propertyNames(tool.inputSchema)) {
        if (published.has(name)) continue;
        expect(FORBIDDEN_FIELD.test(name), `${tool.name} accepts "${name}"`).toBe(false);
      }
    }
  });

  it('never leaves an object open to properties it did not declare', () => {
    for (const tool of CORTEX_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties, `${tool.name} declares properties`).toBeDefined();
      // `true` is the only value that would admit an undeclared field. The spec's
      // blocks leave the keyword off entirely, so the closure has to be enforced by
      // the server rather than read off the schema — see the wire test below.
      expect(tool.inputSchema.additionalProperties).not.toBe(true);
    }
  });
});

describe('invariant 8 — no credential field on the surface, under any name', () => {
  it('has none in the source text of src/mcp, commented out or otherwise', () => {
    // The wire check alone cannot see a field that is commented out or flagged off,
    // and invariant 8 names both cases explicitly.
    const published = fieldsPublishedInSpec();

    for (const file of ['tools.ts', 'server.ts']) {
      const source = readFileSync(new URL(`../src/mcp/${file}`, import.meta.url), 'utf8');
      for (const line of source.split('\n')) {
        const declaration = line.match(/^\s*\/?\/?\s*'?([a-z_]+)'?\s*:/);
        if (!declaration || published.has(declaration[1]!)) continue;
        expect(FORBIDDEN_FIELD.test(declaration[1]!), `${file}: ${line.trim()}`).toBe(false);
      }
    }
  });
});

describe('a client over stdio', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: 'cortex-u7-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: 'npx',
        args: ['tsx', 'scripts/serve-mcp.mts'],
        cwd: repoRoot,
        stderr: 'pipe',
      }),
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it('lists the three write tools and gets the spec schemas back over the wire', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);

    const published = schemasPublishedInSpec();
    for (const [name, block] of published) {
      const overTheWire = tools.find((tool) => tool.name === name);
      expect(overTheWire, `${name} arrived`).toBeDefined();
      expect(overTheWire!.description).toBe(block.description);
      expect(overTheWire!.inputSchema).toEqual(block.inputSchema);
    }
  });

  it('advertises no read tools — reads belong to the managed MCP server', async () => {
    const { tools } = await client.listTools();
    // `05` §3: "Write operations only." A recall tool appearing here would move the
    // read path off Cloud RBAC and onto code we wrote, which is the whole point of
    // the split in `04` §2.
    expect(tools.some((tool) => /recall|read|search|select/i.test(tool.name))).toBe(false);
  });

  it('rejects an unknown tool rather than answering it', async () => {
    await expect(client.callTool({ name: 'cortex_drop_everything', arguments: {} })).rejects.toThrow(
      /unknown tool/i,
    );
  });

  it('refuses an argument the schema did not declare — invariant 7 on the wire', async () => {
    // The spec's blocks omit `additionalProperties`, so a permissive server would
    // accept this and hand it to whatever U8 writes. Closing it here means no
    // undeclared key ever reaches a handler, which is what invariant 7 actually asks
    // for; the schema alone only documents the intent.
    await expect(
      client.callTool({
        name: 'cortex_propose',
        arguments: { repo: 'r', table: 'claims', sql: 'DROP TABLE claims' },
      }),
    ).rejects.toThrow(/undeclared argument/i);
  });

  it('reports the three tools as not yet implemented, and does not decide', async () => {
    // U7 is the skeleton. If a call to propose ever returns `granted`, `blocked` or
    // `deduped` from here, arbitration has been implemented outside the single
    // transaction U8 owns — invariants 1, 3 and 4 all fail silently at that moment.
    for (const name of TOOL_NAMES) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError, `${name} reports an error`).toBe(true);

      const text = JSON.stringify(result.content);
      expect(text).toMatch(/not implemented/i);
      expect(text).not.toMatch(/granted|blocked|deduped/);
    }
  });
});
