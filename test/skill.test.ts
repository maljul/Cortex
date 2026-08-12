/**
 * The Agent Skill. spec/05-INTERFACES.md §4, spec/03-MEMORY-MODEL.md §4.1.
 *
 * U10's named silent break is "shipping recall SQL in the skill that drops a `repo_id`
 * predicate". There are two of them — the one in the `near` CTE and the one on the
 * `LEFT JOIN` — and per V5 a missing filter fails *open*: the planner drops to a full
 * scan and returns another tenant's rows rather than erroring. V14 measured the second
 * one going missing: repo A's recall ranked on repo B's revert history.
 *
 * So the skill does not get to contain a copy of the query. It gets to contain **the**
 * query, held byte-for-byte against `src/memory/recall.ts` by the first test below. A
 * skill that drifts from the implementation fails here rather than in someone's
 * repository.
 *
 * The section list is parsed out of `05` §4 at run time rather than snapshotted, the
 * same way `test/mcp.test.ts` holds the tool schemas against `05` §3 — a reworded spec
 * should fail the test, not silently disagree with it.
 */
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_DISTANCE, RECALL_SQL } from '../src/memory/recall.js';
import { vector } from './helpers/vectors.js';

const SKILL = readFileSync(new URL('../skills/cortex-memory/SKILL.md', import.meta.url), 'utf8');
const SPEC = readFileSync(new URL('../spec/05-INTERFACES.md', import.meta.url), 'utf8');

/** The one fenced `sql` block in the skill. More than one would be ambiguous. */
function skillSql(): string {
  const blocks = [...SKILL.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
}

describe('the recall SQL is pinned, not retyped (§4.2)', () => {
  it('is byte-for-byte the query src/memory/recall.ts issues', () => {
    expect(skillSql()).toBe(RECALL_SQL.trim());
  });

  it('carries both repo_id predicates', () => {
    const sql = skillSql();

    // Asserted separately from the equality above, on purpose. If someone changes both
    // files together the equality still passes, and this is the assertion that then
    // fails — the invariant is "both predicates exist", not "the two files agree".
    expect(sql).toContain('WHERE repo_id = $2');
    expect(sql).toContain('AND i.repo_id = $2');
  });

  // The SQL is pinned but `$4` is a *parameter*, so the query text is identical at any
  // threshold and the byte-for-byte test above cannot see this drift at all. The skill is
  // what an agent in another repository actually copies, so a stale number here ships a
  // narrower memory than the mechanism has — silently, and to the one audience that cannot
  // check it against the source. Added 2026-08-12 when the constant moved 0.35 → 0.60 (V34).
  it('publishes the threshold the mechanism actually ships', () => {
    const row = SKILL.match(/\|\s*`\$4`\s*\|[^|]*\|\s*`([\d.]+)`\s*\|/);
    expect(row, 'no $4 row in the parameter table').not.toBeNull();
    expect(Number(row![1])).toBe(DEFAULT_MAX_DISTANCE);
  });
});

describe('the skill covers every section §4 asks for', () => {
  it('has a heading for each of the six numbered contents', () => {
    const section = SPEC.slice(SPEC.indexOf('## 4. Agent Skill'), SPEC.indexOf('## 5. Demo'));
    const required = [...section.matchAll(/^\d+\.\s+\*\*(.+?)\.?\*\*/gm)].map((m) => m[1]!);

    expect(required.length).toBe(6);
    expect(required.filter((heading) => !SKILL.includes(heading))).toEqual([]);
  });

  it('tells the agent what each decision means, in the words the tool returns', () => {
    for (const decision of ['granted', 'deduped', 'blocked']) {
      expect(SKILL).toContain(`\`${decision}\``);
    }
  });
});

describe('invariant 8 — no credential on any surface', () => {
  it('names the variables and carries no value for any of them', () => {
    expect(SKILL).toContain('CORTEX_READER_DSN');

    // §8 test 8 admits no exceptions "including commented out or feature-flagged off".
    // A DSN pasted into a skill is published the moment the skill is installable.
    expect(SKILL).not.toMatch(/postgres(ql)?:\/\/[^\s`]*:[^\s`]*@/);
    expect(SKILL).not.toMatch(/sslmode=/);
    expect(SKILL).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });
});

describe('the shipped query runs as cortex_reader, with no CORTEX code in the path', () => {
  it('executes over CORTEX_READER_DSN and returns rows', async () => {
    const dsn = process.env.CORTEX_READER_DSN;
    expect(dsn, 'CORTEX_READER_DSN must be set; the read path is this credential').toBeTruthy();

    // A plain `pg` client, the query text lifted out of the published markdown, and
    // parameters. Nothing from `src/memory/` runs here — that is what "without any
    // bespoke client" has to mean if it is to mean anything testable.
    const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
    await client.connect();

    try {
      const result = await client.query(skillSql(), [
        `[${vector(4242).join(',')}]`,
        '00000000-0000-0000-0000-000000000000',
        40,
        DEFAULT_MAX_DISTANCE,
        8,
      ]);

      // An empty tenant returns no rows, and that is a successful recall: the query
      // parsed, the planner accepted it, and `cortex_reader` was permitted to read
      // `findings` and `intents`. A privilege failure throws instead.
      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
