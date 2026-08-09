/**
 * The CORTEX MCP server — the write plane. spec/05-INTERFACES.md §3.
 *
 * U7 advertised the three write tools; U8 gave `cortex_propose` a handler.
 * `cortex_close` (U9) and `cortex_heartbeat` (on `08` §6's cut list) still answer
 * not-implemented, because each of them has to run inside a single transaction in
 * `src/memory/`, and a handler wired up here ahead of that transaction is precisely
 * how invariant 1 gets broken quietly.
 *
 * Two things this file must never grow:
 *
 * - **A read tool.** `05` §3: "Write operations only." Reads go through the
 *   CockroachDB Cloud Managed MCP Server so the agent's read access is governed by
 *   Cloud RBAC and audit logging rather than by code in this repository (`04` §2).
 * - **SQL.** All SQL lives in `src/memory/` or `src/db/`. This layer translates a
 *   tool call into a typed call and nothing else.
 *
 * Nothing here writes to stdout except the transport. On stdio, stdout *is* the
 * protocol channel — a stray log line is a parse error at the client.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { Embedder } from '../embed/titan.js';
import { expandKeys, ResourceKeyError } from '../memory/keys.js';
import { propose, type ProposeResult } from '../memory/propose.js';
import { resolveRepoId } from '../memory/repos.js';
import { CORTEX_TOOLS, findTool, type ToolDefinition } from './tools.js';
import { rejectUndeclaredArguments, validateArguments } from './validate.js';

/** This server surface's own version, not the package's. */
const SERVER_VERSION = '0.1.0';

/** Which unit implements each tool, so a caller is told what is missing, not just that something is. */
const IMPLEMENTED_BY: Record<string, string> = {
  cortex_close: 'U9',
  cortex_heartbeat: 'U9, and on the cut list in 08 §6',
};

/**
 * The decision an agent receives, in the field names `05` §1 gives it.
 *
 * §1 and §4.2 of `03` name the same field differently — `ofIntentId` against `of`,
 * and `key` against the `resource_key` the SQL returns. The core library kept §4.2's
 * names because it is §4.2's transaction; the tool boundary answers in §1's, because
 * §1 is where the shape an agent codes against is written down. Recorded in
 * docs/SPEC-DELTA.md rather than reconciled by choosing one and ignoring the other.
 *
 * Fields §1 does not list are added, never renamed: `distance` and `status` on a
 * dedupe, `expiresAt` on a contested key. The last one is what lets a blocked agent
 * decide whether to re-plan or to come back, which is invariant 3's whole purpose.
 */
function asDecision(result: ProposeResult): Record<string, unknown> {
  switch (result.decision) {
    case 'granted':
      return {
        decision: 'granted',
        intentId: result.intentId,
        keys: result.keys,
        expiresAt: result.expiresAt.toISOString(),
      };
    case 'deduped':
      return {
        decision: 'deduped',
        ofIntentId: result.of,
        holder: result.holder,
        status: result.status,
        outcome: result.outcome ?? null,
        distance: result.distance,
      };
    case 'blocked':
      return {
        decision: 'blocked',
        contested: result.contested.map((contested) => ({
          key: contested.resourceKey,
          holder: contested.holder,
          intentId: contested.intentId,
          expiresAt: contested.expiresAt.toISOString(),
        })),
      };
  }
}

/**
 * `cortex_propose` — `05` §3, over the arbitration transaction in `03` §4.2.
 *
 * The order of the four steps is load-bearing. Both refusals come first, so a call
 * that will not be honoured has neither registered a repository nor spent a Bedrock
 * invocation before it is turned away.
 */
async function handlePropose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repo = args['repo'] as string;
  const agentId = args['agent_id'] as string;
  const statement = args['statement'] as string;
  const requested = args['resource_keys'] as string[];

  let keys: string[];
  try {
    keys = await expandKeys(requested, (pattern) => {
      // `03` §3 makes a glob's overlap with the files it matches structural: the
      // glob is claimed as one row per matched file plus a row for the glob itself.
      // That needs a checkout to match against, and `05` §6 configures the server
      // with no repository root. Claiming the bare `glob:` row instead would leave a
      // later `file:` claim on a matched path unblocked — a double grant, with no
      // error anywhere. §3's own default is to refuse rather than widen.
      throw new McpError(
        ErrorCode.InvalidParams,
        `cortex_propose cannot expand glob:${pattern} — the MCP server has no repository ` +
          'checkout to match it against. Name the files.',
      );
    });
  } catch (error) {
    if (error instanceof ResourceKeyError) {
      throw new McpError(ErrorCode.InvalidParams, error.message);
    }
    throw error;
  }

  const repoId = await resolveRepoId(repo);
  const embedding = await getEmbedder().embed(statement);

  const result = await propose({ repoId, agentId, statement, resourceKeys: keys, embedding });

  // Not `isError`. `blocked` and `deduped` are ordinary outcomes of a working
  // arbitration transaction (`03` §4.2, invariants 3 and 4), and an agent that is
  // handed one as an error retries through it — which turns the fleet into the
  // queue `03` §5 exists to prevent.
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(asDecision(result), null, 2) }],
  };
}

/**
 * One embedder for the process, so U5's content-hash cache spans calls.
 *
 * Process-wide rather than per-server: the cache is the unit's whole point, and a
 * fresh one per `createServer()` would re-embed a repeated statement.
 *
 * Lazy for the same reason `db/pool.ts` is. `Embedder`'s constructor reads
 * `BEDROCK_REGION`, and the entry point loads `.env` in its body — which runs after
 * every import in the file has already been evaluated. Constructing at module scope
 * would read the environment one step too early and silently take the SDK's default
 * region instead of the configured one.
 */
let shared: Embedder | undefined;

function getEmbedder(): Embedder {
  shared ??= new Embedder();
  return shared;
}

export function createServer(): Server {
  const server = new Server(
    { name: 'cortex', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CORTEX_TOOLS.map((tool) => ({ ...tool })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);

    if (tool === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }

    if (tool.name === 'cortex_propose') {
      return await handlePropose(validateArguments(tool, request.params.arguments));
    }

    // No handler yet, but the surface still closes: a structural argument is refused
    // before anything discovers there is nothing behind it (invariant 7).
    rejectUndeclaredArguments(tool, request.params.arguments);
    return notImplemented(tool);
  });

  return server;
}

function notImplemented(tool: ToolDefinition): Record<string, unknown> {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: `${tool.name} is not implemented yet (${IMPLEMENTED_BY[tool.name]}). The tool surface is live; the write path is not.`,
      },
    ],
  };
}
