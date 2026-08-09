/**
 * Argument checking for the CORTEX MCP write plane. spec/05-INTERFACES.md §3.
 *
 * Driven off each tool's own `inputSchema` rather than written out per tool, so
 * there is nothing here that can disagree with §3 — the schemas are copied verbatim
 * from the spec and pinned against it by `test/mcp.test.ts`, and this reads them.
 *
 * This is invariant 7's enforcement point: no agent-reachable path accepts SQL, a
 * table name, or any structural parameter. §3's blocks omit `additionalProperties`,
 * so the published schema documents a closed field list without enforcing one; the
 * closure has to happen here, because invariant 7 is a claim about what reaches a
 * handler and not about what a schema says.
 *
 * Only the keywords §3 actually uses are implemented. A validator that understood
 * more of JSON Schema than the spec writes would be untested code on the boundary.
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { ToolDefinition } from './tools.js';

function invalid(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

/**
 * Refuses any argument the schema did not declare.
 *
 * Separate from the full check below because an unimplemented tool still has to
 * close its surface: `cortex_close` and `cortex_heartbeat` have no handler, and a
 * structural argument must be refused before that is discovered, not after.
 */
export function rejectUndeclaredArguments(
  tool: ToolDefinition,
  args: Record<string, unknown> | undefined,
): void {
  if (args === undefined) return;

  const declared = new Set(Object.keys(tool.inputSchema.properties));
  const undeclared = Object.keys(args).filter((name) => !declared.has(name));

  if (undeclared.length > 0) {
    invalid(
      `Undeclared argument to ${tool.name}: ${undeclared.sort().join(', ')}. ` +
        `Accepted: ${[...declared].sort().join(', ')}.`,
    );
  }
}

function checkValue(tool: string, name: string, value: unknown, spec: Record<string, unknown>): void {
  const allowed = spec['enum'] as unknown[] | undefined;
  if (allowed !== undefined && !allowed.includes(value)) {
    invalid(`${tool}.${name} must be one of: ${allowed.join(', ')}.`);
  }

  switch (spec['type'] as string | undefined) {
    case 'string': {
      if (typeof value !== 'string') invalid(`${tool}.${name} must be a string.`);
      const longest = spec['maxLength'] as number | undefined;
      if (longest !== undefined && (value as string).length > longest) {
        invalid(
          `${tool}.${name} must be at most ${longest} characters; got ${(value as string).length}.`,
        );
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) invalid(`${tool}.${name} must be an array.`);
      const most = spec['maxItems'] as number | undefined;
      if (most !== undefined && (value as unknown[]).length > most) {
        invalid(
          `${tool}.${name} must have at most ${most} items; got ${(value as unknown[]).length}.`,
        );
      }
      const itemType = (spec['items'] as { type?: string } | undefined)?.type;
      if (itemType !== undefined) {
        for (const [at, item] of (value as unknown[]).entries()) {
          if (typeof item !== itemType) {
            invalid(`${tool}.${name}[${at}] must be a ${itemType}.`);
          }
        }
      }
      return;
    }
    case 'integer': {
      if (!Number.isInteger(value)) invalid(`${tool}.${name} must be an integer.`);
      return;
    }
    default:
      // §3 gives `result` an `enum` and no `type`, already checked above.
      return;
  }
}

/**
 * Checks a call against its tool's published schema and returns the arguments.
 *
 * Refuses rather than coerces. A silently coerced argument is how a `statement`
 * that was meant to be one sentence becomes the string "[object Object]" and
 * embeds to a vector that dedupes against nothing.
 */
export function validateArguments(
  tool: ToolDefinition,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  rejectUndeclaredArguments(tool, args);

  const supplied = args ?? {};

  for (const name of tool.inputSchema.required ?? []) {
    if (supplied[name] === undefined) {
      invalid(`${tool.name} requires ${name}.`);
    }
  }

  for (const [name, value] of Object.entries(supplied)) {
    if (value === undefined) continue;
    const spec = tool.inputSchema.properties[name];
    if (spec !== undefined) checkValue(tool.name, name, value, spec);
  }

  return supplied;
}
