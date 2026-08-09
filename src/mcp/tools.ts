/**
 * The CORTEX MCP write plane's tool definitions. spec/05-INTERFACES.md §3.
 *
 * These objects are copies of the JSON blocks in §3, not paraphrases of them.
 * `05` §3 is explicit that the `description` fields are "prompt surface, not
 * documentation" — they are what makes an unmodified third-party agent call
 * `cortex_propose` before it writes a file, so an improvement to the wording is a
 * change to behaviour. `test/mcp.test.ts` parses §3 out of the markdown at run time
 * and deep-compares, so a reworded string fails rather than drifts.
 *
 * No SQL lives here and none may: this file is data, and the whole point of §3's
 * closed field lists is that nothing structural crosses the tool boundary
 * (invariant 7).
 */

/**
 * A JSON Schema as §3 writes it — an object with a closed property list. Values are
 * `unknown` because §3 is not uniform: `result` carries an `enum` and no `type`.
 */
export interface ToolInputSchema {
  type: 'object';
  required?: string[];
  properties: Record<string, Record<string, unknown>>;
  additionalProperties?: false;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

const cortexPropose: ToolDefinition = {
  name: 'cortex_propose',
  description:
    'Declare an intent to modify a resource and request the exclusive right to do so. MUST be called before any file write, migration, or other side effect. Returns granted, deduped, or blocked.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'agent_id', 'statement', 'resource_keys'],
    properties: {
      repo: { type: 'string' },
      agent_id: { type: 'string' },
      statement: {
        type: 'string',
        maxLength: 500,
        description:
          'What you intend to do, in one sentence, specific enough that a teammate could recognise it as the same task.',
      },
      resource_keys: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 200,
        description:
          'Canonical keys: file:<path>, glob:<pattern>, migration:<id>, service:<name>:<verb>',
      },
    },
  },
};

const cortexClose: ToolDefinition = {
  name: 'cortex_close',
  description:
    'Record the outcome of an intent and release its claims. Call exactly once per granted intent, including when the work failed.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'intent_id', 'result', 'idempotency_key'],
    properties: {
      repo: { type: 'string' },
      intent_id: { type: 'string' },
      result: { enum: ['done', 'abandoned', 'reverted'] },
      files_changed: { type: 'array', items: { type: 'string' } },
      notes: {
        type: 'string',
        maxLength: 2000,
        description:
          'What a future agent should know. This becomes durable semantic memory.',
      },
      tokens_spent: { type: 'integer' },
      idempotency_key: { type: 'string' },
    },
  },
};

/**
 * DERIVED, NOT VERBATIM — and the only tool here that is.
 *
 * `05` §3 gives `cortex_heartbeat` two sentences of prose and no JSON block, while
 * U7's done-when asks for three tools with §3 schemas. The gap is in the spec, not
 * in the reading of it. Rather than invent a shape, this takes §1's core-library
 * signature, which the spec does give: `heartbeat(repo, intentId, extendBy?)`.
 *
 * The description states the obligation rather than the mechanism, per §3's two
 * rules for description discipline. If §3 ever grows a block for this tool, that
 * block wins and `test/mcp.test.ts` fails until this is replaced by it.
 */
const cortexHeartbeat: ToolDefinition = {
  name: 'cortex_heartbeat',
  description:
    'Extend the lease on an intent you still hold. MUST be called before the lease expires on work that runs longer than one lease, or the claims are released and another agent may legitimately acquire them.',
  inputSchema: {
    type: 'object',
    required: ['repo', 'intent_id'],
    properties: {
      repo: { type: 'string' },
      intent_id: { type: 'string' },
      extend_by: {
        type: 'string',
        description: 'How much longer the work needs, as a duration such as "10m". Defaults to one full lease.',
      },
    },
  },
};

/** Write operations only. Reads go through the managed MCP server — `04` §2. */
export const CORTEX_TOOLS: readonly ToolDefinition[] = [
  cortexPropose,
  cortexClose,
  cortexHeartbeat,
];

export const TOOL_NAMES: readonly string[] = CORTEX_TOOLS.map((tool) => tool.name);

export function findTool(name: string): ToolDefinition | undefined {
  return CORTEX_TOOLS.find((tool) => tool.name === name);
}
