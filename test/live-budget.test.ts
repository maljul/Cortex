/**
 * THE LIVE RUN BUDGET — spec/04-ARCHITECTURE.md §5 brake 2, and rung 1's other end.
 *
 * §5: "A run counter in CockroachDB, default 40 LIVE runs per day globally. On exhaustion
 * the UI switches to REPLAY and says so plainly." The cap that ships is not 40 and is not a
 * chosen number either: since U24 it is derived from one metered LIVE run's own Bedrock usage,
 * per design §7.3. See `LIVE_RUNS_PER_DAY` and `docs/DECISIONS.md`. Everything else in that
 * sentence is asserted here.
 *
 * **This is the project's seventh table and its first row that is not tenant memory.** Both
 * of those are deliberate and both are load-bearing, so both are tested rather than
 * described:
 *
 * - **Invariant 5 — every read carries `WHERE repo_id`.** This table has no `repo_id`, and
 *   cannot: §5 requires the counter to be *global*, so a per-tenant counter would not be the
 *   brake §5 specifies. The invariant protects tenant memory from leaking across a missing
 *   filter, so the exception is only safe while the table holds nothing a tenant could own —
 *   and that is asserted below against `information_schema`, not asserted in a comment.
 * - **Invariant 6 — every write path is wrapped in the 40001 retry helper.** The increment
 *   is a write, and it is the write two visitors collide on.
 * - **Invariant 7 — no agent-reachable path accepts a structural parameter.** The day is
 *   the cluster's own `current_date` and never a caller's value; the only bind is the cap.
 *
 * **What the concurrency test actually proves, which is not what it was written to prove.**
 * It was written expecting read-then-write in two statements to let two visitors both read 9
 * and both write 10. That mutation was run and the test **still passed**: `withRetry` puts
 * every caller at SERIALIZABLE, so a concurrent increment invalidates the losing
 * transaction's read and the retry loop re-runs it. The isolation level is the brake, and
 * the single statement is a round trip saved rather than a race closed. Both files' comments
 * were corrected to say so rather than keeping the tidier story.
 *
 * The mutation that does bite is deleting `WHERE b.runs_used < $1` from the claim SQL: six
 * of the ten tests below fail, this one included. That is what holds the cap up.
 *
 * These tests move the real counter, because there is only one and its day is the cluster's.
 * The original value is captured before and restored after; a test run must not spend the
 * demo's budget for the day.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool } from '../src/db/pool.js';
import {
  LIVE_BUDGET_CLAIM_SQL,
  LIVE_BUDGET_USD,
  LIVE_RUNS_PER_DAY,
  METERED_LIVE_RUN,
  authoriseLiveRun,
  liveBudget,
  liveRunCostUsd,
} from '../src/memory/live-budget.js';

let original: number | null = null;

async function admin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Puts today's counter at a known value so the assertions below are about the mechanism. */
async function setUsed(used: number): Promise<void> {
  await admin(async (client) => {
    await client.query(
      `INSERT INTO live_run_budget (day, runs_used) VALUES (current_date, $1)
       ON CONFLICT (day) DO UPDATE SET runs_used = $1`,
      [used],
    );
  });
}

async function readUsed(): Promise<number | null> {
  return admin(async (client) => {
    const { rows } = await client.query<{ runs_used: string }>(
      'SELECT runs_used FROM live_run_budget WHERE day = current_date',
    );
    return rows[0] ? Number(rows[0].runs_used) : null;
  });
}

beforeAll(async () => {
  original = await readUsed();
});

afterAll(async () => {
  await admin(async (client) => {
    if (original === null) {
      await client.query('DELETE FROM live_run_budget WHERE day = current_date');
    } else {
      await client.query(
        `INSERT INTO live_run_budget (day, runs_used) VALUES (current_date, $1)
         ON CONFLICT (day) DO UPDATE SET runs_used = $1`,
        [original],
      );
    }
  });
  await closePool();
});

describe('the cap is one number in one place', () => {
  it('is derived from a metered run rather than chosen (U24)', () => {
    // **This used to assert `toBe(10)` and that is the assertion U24 removed.** Ten was
    // Julian's call on 2026-08-12 against the *old* five-agent scenario, and `docs/UNITS.md`
    // recorded it as wrong for this workload by roughly an order of magnitude and gating
    // nothing, because no route called `authoriseLiveRun`. A literal here would have gone on
    // passing through both of those facts.
    //
    // What is asserted instead is design §7.3's formula, recomputed from the same inputs: the
    // cap must be what one metered run's own Bedrock usage affords out of the LIVE budget.
    // Move the measurement and this follows; edit the cap without the measurement and it
    // fails. The fuller arithmetic — and why a per-UTC-day counter cannot carry a whole-event
    // budget at these numbers — is in `test/ladder.test.ts` and in the constant's own comment.
    expect(METERED_LIVE_RUN).not.toBeNull();
    expect(LIVE_RUNS_PER_DAY).toBe(
      Math.floor(LIVE_BUDGET_USD / liveRunCostUsd(METERED_LIVE_RUN!)),
    );
  });

  it('binds the cap and never the day — invariant 7', () => {
    // The day comes from the cluster. A caller-supplied day would let an anonymous visitor
    // choose which counter to spend, which is the same class of mistake as a caller-supplied
    // table name and is why §5 says the counter is global rather than per-request.
    expect(LIVE_BUDGET_CLAIM_SQL).toContain('current_date');
    expect(LIVE_BUDGET_CLAIM_SQL).toContain('$1');
    expect(LIVE_BUDGET_CLAIM_SQL).not.toContain('$2');
  });
});

describe('the table holds nothing a tenant could own — invariant 5', () => {
  it('has no repo_id, and no other column naming a session', async () => {
    const columns = await admin(async (client) => {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'live_run_budget' ORDER BY column_name`,
      );
      return rows.map((r) => r.column_name);
    });

    expect(columns.length).toBeGreaterThan(0);
    // The whole justification for this table being exempt from `WHERE repo_id` is that
    // there is no tenant in it. That is a claim about the schema, so it is asked of the
    // schema — if a later unit adds a per-session column here, invariant 5 applies again
    // and this fails rather than the exemption quietly widening.
    for (const column of columns) {
      expect(column).not.toMatch(/repo|session|agent|intent|tenant/i);
    }
  });
});

describe('brake 2 — the counter authorises and then degrades', () => {
  it('grants while under the cap and counts each grant', async () => {
    await setUsed(0);

    const first = await authoriseLiveRun({ cap: 3 });
    expect(first.mode).toBe('live');
    expect(first.used).toBe(1);
    expect(first.remaining).toBe(2);

    const second = await authoriseLiveRun({ cap: 3 });
    expect(second.mode).toBe('live');
    expect(second.used).toBe(2);
  });

  it('degrades to replay at the cap, and says so plainly rather than failing', async () => {
    await setUsed(3);

    const exhausted = await authoriseLiveRun({ cap: 3 });

    // `05` §5: "POST /demo/run MUST NOT fail when the LIVE quota is exhausted. It returns a
    // replay run together with the reason it is not live. Exhaustion is a normal return
    // value, exactly as a blocked claim is in §1."
    expect(exhausted.mode).toBe('replay');
    expect(exhausted.used).toBe(3);
    expect(exhausted.remaining).toBe(0);
    expect(exhausted.reason).toBeTruthy();
  });

  it('states what is still true, per `04` §5 invariant 2', async () => {
    await setUsed(3);
    const { reason } = await authoriseLiveRun({ cap: 3 });

    // Rung 1's row in §5's ladder ends "database behaviour fully live". A rung that says
    // only "quota exhausted" misrepresents liveness by omission on the one page a judge
    // reads, which is what invariant 2 forbids. The cluster may be named either way — what
    // is asserted is that the sentence states the database is still live, not which noun
    // it reaches for.
    expect(reason).toMatch(/database|CockroachDB/i);
    expect(reason).toMatch(/live/i);
    // And that it says *what* was degraded, so the two halves cannot drift apart.
    expect(reason).toMatch(/reasoning/i);
  });

  it('does not spend the counter past its cap however many times it is asked', async () => {
    await setUsed(3);
    await authoriseLiveRun({ cap: 3 });
    await authoriseLiveRun({ cap: 3 });
    await authoriseLiveRun({ cap: 3 });

    expect(await readUsed()).toBe(3);
  });

  it('reads the budget without spending it', async () => {
    await setUsed(2);

    const budget = await liveBudget({ cap: 5 });

    expect(budget.used).toBe(2);
    expect(budget.remaining).toBe(3);
    expect(await readUsed()).toBe(2);
  });

  it('reports an untouched day as nothing spent', async () => {
    await admin(async (client) => {
      await client.query('DELETE FROM live_run_budget WHERE day = current_date');
    });

    const budget = await liveBudget({ cap: 4 });
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(4);
  });
});

describe('the check and the increment cannot be raced', () => {
  it('gives exactly three of ten simultaneous callers a live slot', async () => {
    await setUsed(0);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => authoriseLiveRun({ cap: 3 })),
    );

    const granted = results.filter((r) => r.mode === 'live');

    // The failure this prevents: read-then-write in two statements lets two visitors both
    // read 2 and both write 3, so the eleventh run of the day reasons for free. One
    // statement under SERIALIZABLE cannot, and `withRetry` turns the resulting 40001s into
    // ordinary traffic rather than into an error page.
    expect(granted).toHaveLength(3);
    expect(await readUsed()).toBe(3);

    // Every caller got an answer. None of them saw an exception, which is what invariant 1
    // requires of the path behind the run button.
    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(['live', 'replay']).toContain(result.mode);
    }

    // And the ones that lost carry the reason, not an empty field.
    for (const denied of results.filter((r) => r.mode === 'replay')) {
      expect(denied.reason).toBeTruthy();
    }
  });
});
