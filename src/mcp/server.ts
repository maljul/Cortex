/**
 * The CORTEX MCP server — the write plane. spec/05-INTERFACES.md §3.
 *
 * U7 is the skeleton: it advertises the three write tools and answers `tools/list`
 * over a transport. It deliberately implements no handler. `cortex_propose` belongs
 * to U8 and `cortex_close`/`cortex_heartbeat` to U9, because each of them has to run
 * inside the single arbitration transaction in `src/memory/`, and a handler wired up
 * here ahead of that transaction is precisely how invariant 1 gets broken quietly.
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

import { CORTEX_TOOLS, findTool, type ToolDefinition } from './tools';

/** This server surface's own version, not the package's. */
const SERVER_VERSION = '0.1.0';

/** Which unit implements each tool, so a caller is told what is missing, not just that something is. */
const IMPLEMENTED_BY: Record<string, string> = {
  cortex_propose: 'U8',
  cortex_close: 'U9',
  cortex_heartbeat: 'U9',
};

/**
 * Closes the tool schema against arguments it does not declare.
 *
 * `05` §3's blocks omit `additionalProperties`, so the schema as published documents
 * a closed field list without enforcing one. Invariant 7 — no agent-reachable path
 * accepts SQL, a table name, or any structural parameter — is a statement about what
 * reaches a handler, not about what a schema says, so the check belongs here, on the
 * boundary, before any handler exists to receive it.
 */
function rejectUndeclaredArguments(
  tool: ToolDefinition,
  args: Record<string, unknown> | undefined,
): void {
  if (args === undefined) return;

  const declared = new Set(Object.keys(tool.inputSchema.properties));
  const undeclared = Object.keys(args).filter((key) => !declared.has(key));

  if (undeclared.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Undeclared argument to ${tool.name}: ${undeclared.sort().join(', ')}. ` +
        `Accepted: ${[...declared].sort().join(', ')}.`,
    );
  }
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

    rejectUndeclaredArguments(tool, request.params.arguments);

    // An error, not a decision. `blocked` and `deduped` are ordinary results of a
    // working arbitration transaction (`03` §4.2); returning either from a server
    // that has no transaction would tell an agent it may proceed, or may not, on no
    // evidence at all.
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `${tool.name} is not implemented yet (${IMPLEMENTED_BY[tool.name]}). The tool surface is live; the write path is not.`,
        },
      ],
    };
  });

  return server;
}
