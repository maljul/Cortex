/**
 * The integration guide. `docs/integration.md`.
 *
 * The guide is the page a stranger follows to attach their own agent, so every claim it makes
 * about this repository is a claim someone will act on. CLAUDE.md's rule is that a doc asserting
 * something no test checks is a lie, and this file is that check.
 *
 * Two of its claims exist *because* the obvious thing was measured false on 2026-08-17 and both
 * are the reason this file exists rather than a nicety:
 *
 *   - `npx cortex` does not run this CLI. `node_modules/.bin/cortex` is not created for a
 *     package's own bin, and the public registry carries an unrelated package under that name —
 *     so the README's documented command fetched and ran a stranger's code. The guide documents
 *     `node bin/cortex.mjs`, and the test below fails if `npx cortex` is ever reintroduced.
 *   - `npm run serve` puts npm's lifecycle banner on **stdout**, where the stdio MCP contract
 *     admits JSON-RPC frames and nothing else. The guide's attach command is the one form that is
 *     clean, needs no particular working directory, and reaches for nothing over the network;
 *     the test asserts both of its path components exist, because an attach command naming a
 *     path that is not there is the one failure a reader cannot debug.
 *
 * What is deliberately NOT asserted here: that stdout is clean. Proving that means spawning four
 * servers and speaking MCP to each, which is `test/mcp.test.ts`'s job for the form under test and
 * is too slow to repeat per command. The measurement is recorded in `docs/verification-log.md`.
 */
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CORTEX_TOOLS } from '../src/mcp/tools.js';

const GUIDE = readFileSync(new URL('../docs/integration.md', import.meta.url), 'utf8');
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** Every `process.env.X` this repository actually reads, from source rather than from memory. */
function envVarsReadBySource(): Set<string> {
  const found = new Set<string>();
  const roots = ['../src', '../scripts', '../bench', '../infra/lambda'];
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir)) {
      const child = new URL(`${entry}`, `${dir.href}/`);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|mts|mjs)$/.test(entry)) continue;
      const text = readFileSync(child, 'utf8');
      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(m[1]!);
      for (const m of text.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) found.add(m[1]!);
    }
  };
  for (const root of roots) {
    const dir = new URL(root, import.meta.url);
    if (existsSync(dir)) walk(dir);
  }
  return found;
}

/**
 * What a reader copies is what is inside a fenced block. Prose *warning* about `npx cortex` is
 * the correct thing for both pages to carry, so the assertion is scoped to the runnable text —
 * asserting on the whole document would forbid the warning as well as the mistake.
 */
function fencedCommands(markdown: string): string {
  // Scanned line by line rather than with one regex. A regex over the whole document pairs a
  // *closing* fence with the next *opening* one and returns the prose between them, which made
  // this assertion fail on a sentence warning against the very command it was checking for.
  const SHELL = new Set(['', 'bash', 'sh', 'shell', 'console', 'zsh']);
  const out: string[] = [];
  let language: string | null = null;
  for (const line of markdown.split('\n')) {
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      language = language === null ? fence[1]!.toLowerCase() : null;
      continue;
    }
    if (language !== null && SHELL.has(language)) out.push(line);
  }
  return out.join('\n');
}

describe('the guide documents commands that exist', () => {
  it('offers no runnable `npx cortex`, which resolves to an unrelated package', () => {
    expect(fencedCommands(GUIDE)).not.toMatch(/npx\s+cortex\b/);
  });

  it('and neither does the README, which offered it in five places until 2026-08-17', () => {
    expect(fencedCommands(README)).not.toMatch(/npx\s+cortex\b/);
  });

  it('names the CLI entry point that is actually under test', () => {
    expect(GUIDE).toContain('node bin/cortex.mjs');
    expect(existsSync(new URL('../bin/cortex.mjs', import.meta.url))).toBe(true);
  });

  it('the attach command names two paths that both exist', () => {
    // The command is written with a placeholder absolute prefix, so assert the suffixes.
    expect(GUIDE).toContain('node_modules/.bin/tsx');
    expect(GUIDE).toContain('scripts/serve-mcp.mts');
    expect(existsSync(new URL('../node_modules/.bin/tsx', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../scripts/serve-mcp.mts', import.meta.url))).toBe(true);
  });

  it('warns that `npm run serve` is not an attach command', () => {
    expect(GUIDE).toMatch(/npm run serve/);
    expect(GUIDE).toMatch(/non-protocol/);
  });
});

describe('the guide describes the tool surface that is served', () => {
  it('names exactly the three tools the server advertises, and no fourth', () => {
    const names = CORTEX_TOOLS.map((tool) => tool.name);
    for (const name of names) expect(GUIDE).toContain(name);
    // `cortex_reader` and `cortex_writer` share the prefix and are SQL roles, not tools. They
    // are named on the page deliberately, so exclude them rather than loosening the check.
    const SQL_ROLES = new Set(['cortex_reader', 'cortex_writer', 'cortex_demo']);
    const mentioned = [...GUIDE.matchAll(/\bcortex_[a-z_]+\b/g)]
      .map((m) => m[0])
      .filter((name) => !SQL_ROLES.has(name));
    expect(new Set(mentioned)).toEqual(new Set(names));
  });

  it('does not claim a read tool exists, because none does', () => {
    const readish = CORTEX_TOOLS.filter((tool) => /recall|read|search|select/.test(tool.name));
    expect(readish).toEqual([]);
    expect(GUIDE).toMatch(/Recall is not an MCP tool/);
  });

  it('reports heartbeat as not implemented, which is what the server answers', () => {
    expect(CORTEX_TOOLS.some((tool) => tool.name === 'cortex_heartbeat')).toBe(true);
    expect(GUIDE).toMatch(/`cortex_heartbeat`[\s\S]{0,200}not implemented/);
  });

  it('quotes the propose limits the schema actually declares', () => {
    const propose = CORTEX_TOOLS.find((tool) => tool.name === 'cortex_propose');
    expect(propose).toBeDefined();
    // `ToolInputSchema` types its properties as Record<string, Record<string, unknown>>, so the
    // hops are narrowed one at a time rather than cast through the whole shape.
    const properties = propose!.inputSchema.properties ?? {};
    const statementMax = properties['statement']?.['maxLength'];
    const keysMax = properties['resource_keys']?.['maxItems'];
    expect(typeof statementMax).toBe('number');
    expect(typeof keysMax).toBe('number');
    expect(GUIDE).toContain(`max ${String(statementMax)} characters`);
    expect(GUIDE).toContain(`max ${String(keysMax)}`);
    // The guide lists the required fields; a new required field must reach the page.
    const required = (propose!.inputSchema as { required?: string[] }).required ?? [];
    expect(required.length).toBeGreaterThan(0);
    for (const field of required) expect(GUIDE).toContain(`\`${field}\``);
  });

  it('lists the three decisions and calls none of them an error', () => {
    for (const decision of ['granted', 'blocked', 'deduped']) {
      expect(GUIDE).toContain(`\`${decision}\``);
    }
    expect(GUIDE).toMatch(/none of them is an error/);
  });
});

describe('the guide is honest about what is not built', () => {
  const readByCode = envVarsReadBySource();

  it('CORTEX_REPO is published to agents and read by nothing — still true', () => {
    expect(readByCode.has('CORTEX_REPO')).toBe(false);
    expect(GUIDE).toMatch(/`CORTEX_REPO`[\s\S]{0,160}read by no code/);
  });

  it('CORTEX_LEASE_TTL has no reader — still true', () => {
    expect(readByCode.has('CORTEX_LEASE_TTL')).toBe(false);
    expect(GUIDE).toMatch(/`CORTEX_LEASE_TTL`[\s\S]{0,120}no reader/);
  });

  it('the variables the guide says are required are ones the code reads', () => {
    expect(readByCode.has('CORTEX_WRITER_DSN')).toBe(true);
    expect(readByCode.has('CORTEX_REPO_ROOT')).toBe(true);
    expect(readByCode.has('BEDROCK_EMBED_MODEL')).toBe(true);
    expect(GUIDE).toContain('CORTEX_WRITER_DSN');
    expect(GUIDE).toContain('CORTEX_REPO_ROOT');
  });
});

describe('the guide does not quote a constant it cannot hold', () => {
  /**
   * The recall and dedupe thresholds move — 0.35 → 0.60 and 0.28 → 0.39 already — and a fourth
   * unpinned copy is how the third one went stale. The guide points at the constant instead, so
   * assert it does not carry a bare threshold literal. Distances quoted from the measured
   * transcript are fine and are excluded by requiring the word "threshold"/"distance" nearby.
   */
  it('refers recall distance to DEFAULT_MAX_DISTANCE rather than restating it', () => {
    expect(GUIDE).toContain('DEFAULT_MAX_DISTANCE');
    expect(GUIDE).not.toMatch(/maximum cosine distance[^.]{0,40}\b0\.\d+/);
  });
});

describe('invariant 8 — no credential field, and no credential on the page', () => {
  it('carries no connection-string-shaped literal', () => {
    expect(GUIDE).not.toMatch(/postgres(ql)?:\/\/[^\s`)]*:[^\s`)]*@/);
  });

  it('says no command prints a credential, which is what doctor implements', () => {
    expect(GUIDE).toMatch(/never a value|prints a credential/);
  });
});
