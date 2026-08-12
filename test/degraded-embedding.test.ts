/**
 * RUNG 2 — spec/04-ARCHITECTURE.md §5's degradation ladder, the rung it warns about.
 *
 * | 2 | Bedrock embeddings throttled or unavailable | deterministic local hash embedding,
 *     intent marked `degraded`, dedupe skipped for that intent | database behaviour fully
 *     live, dedupe degraded and labelled as such |
 *
 * §5 also says: "Note that rung 2 is reachable in REPLAY as well as in LIVE. REPLAY caches
 * reasoning, not embeddings, so the demo retains a Bedrock dependency even with LIVE disabled
 * entirely. **This is the rung most likely to fire unnoticed.**" `docs/UNITS.md` carries that
 * forward as U17's instruction to force this one first, and that is why this file exists
 * before the LIVE reasoning path does.
 *
 * **The dangerous half is `degradedEmbedding`, not the fallback vector.** Skipping dedupe is
 * skipping the mechanism this whole project argues for, so the flag that does it is
 * deliberately not a general `skipDedupe`: it is one flag meaning "this vector is not a real
 * embedding", and it skips the search *and* marks the row in the same act. A caller cannot
 * turn dedupe off without simultaneously asserting the embedding is untrustworthy and
 * recording that assertion in the database where the panel and the next query can both see
 * it.
 *
 * **Invariant 1 is not weakened by this and the distinction matters.** §8 invariant 1 is that
 * a similarity check and a claim insert never land in *different* transactions. Not running a
 * similarity check at all is a different thing from splitting one, and §5 requires exactly
 * that when the vector is meaningless. What would falsify the thesis is a dedupe that ran
 * somewhere else, not a dedupe that honestly did not run.
 *
 * **The marked row also has to be invisible to later searches**, which is the half that is
 * easy to leave out. A hash vector sits at an arbitrary distance from every real embedding,
 * so a degraded intent left in the candidate set does not merely fail to help — it corrupts
 * every dedupe decision made after it, permanently, long after Bedrock came back.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { closePool } from '../src/db/pool.js';
import { StatementRecorder } from '../src/db/recorder.js';
import {
  EMBED_DIMENSIONS,
  degradedEmbedding,
  isEmbeddingUnavailable,
  withDegradedFallback,
} from '../src/embed/degraded.js';
import { createDemoSession } from '../src/memory/demo.js';
import { propose } from '../src/memory/propose.js';
import { runScenario } from '../src/demo/scenario.js';

const sessions: string[] = [];

async function session(): Promise<string> {
  const created = await createDemoSession();
  sessions.push(created.sessionId);
  return created.sessionId;
}

afterAll(async () => {
  const admin = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  try {
    for (const id of sessions) {
      await admin.query('DELETE FROM action_ledger WHERE repo_id = $1', [id]);
      await admin.query('DELETE FROM findings WHERE repo_id = $1', [id]);
      await admin.query('DELETE FROM claims WHERE repo_id = $1', [id]);
      await admin.query('DELETE FROM intents WHERE repo_id = $1', [id]);
      await admin.query('DELETE FROM repos WHERE id = $1', [id]);
    }
  } finally {
    await admin.end();
  }
  await closePool();
});

describe('the fallback vector', () => {
  it('is the right width, so it fits the column and the index', () => {
    expect(degradedEmbedding('add a retry to the orders client')).toHaveLength(EMBED_DIMENSIONS);
  });

  it('is deterministic — the same text gives the same vector, always', () => {
    // §5 says "deterministic local hash embedding". Determinism is what makes the degraded
    // path debuggable and what stops two runs of the same demo disagreeing about distances
    // for a reason nobody can reproduce.
    const once = degradedEmbedding('rename the orders status column');
    const twice = degradedEmbedding('rename the orders status column');
    expect(once).toEqual(twice);
  });

  it('separates different texts', () => {
    const a = degradedEmbedding('add a retry to the orders client');
    const b = degradedEmbedding('rename the orders status column');
    expect(a).not.toEqual(b);
  });

  it('is a unit vector, like the model’s own output', () => {
    // Titan returns unit vectors at 1024 dimensions (V5). Cosine distance is undefined for a
    // zero vector and misleading for an unnormalised one, so the stand-in matches the shape
    // of the thing it stands in for even though its distances mean nothing.
    const norm = Math.sqrt(
      degradedEmbedding('anything at all').reduce((sum, x) => sum + x * x, 0),
    );
    expect(norm).toBeCloseTo(1, 6);
  });
});

describe('what counts as "throttled or unavailable"', () => {
  it('recognises throttling, and service unavailability', () => {
    expect(isEmbeddingUnavailable({ name: 'ThrottlingException' })).toBe(true);
    expect(isEmbeddingUnavailable({ name: 'TooManyRequestsException' })).toBe(true);
    expect(isEmbeddingUnavailable({ name: 'ServiceUnavailableException' })).toBe(true);
    expect(isEmbeddingUnavailable({ $metadata: { httpStatusCode: 429 } })).toBe(true);
    expect(isEmbeddingUnavailable({ $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isEmbeddingUnavailable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isEmbeddingUnavailable({ code: 'ECONNRESET' })).toBe(true);
  });

  it('does not swallow a bug', () => {
    // The boundary is deliberate. §5's rung 2 is about Bedrock being throttled or down; a
    // TypeError is this repository being wrong, and degrading quietly around it would hide a
    // defect behind a banner that says everything is fine. Rung 4 is the catch-all for the
    // page staying up, and it says plainly that nothing is live.
    expect(isEmbeddingUnavailable(new TypeError('embedding.map is not a function'))).toBe(false);
    expect(isEmbeddingUnavailable({ name: 'ValidationException' })).toBe(false);
    expect(isEmbeddingUnavailable(null)).toBe(false);
  });

  it('falls back rather than throwing, and says it did', async () => {
    let called = 0;
    const embed = withDegradedFallback(async () => {
      called += 1;
      throw Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });
    });

    const result = await embed('add a retry to the orders client');

    expect(called).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.embedding).toEqual(degradedEmbedding('add a retry to the orders client'));
  });

  it('passes a healthy call straight through, undegraded', async () => {
    const real = Array.from({ length: EMBED_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
    const embed = withDegradedFallback(async () => real);

    const result = await embed('anything');

    expect(result.degraded).toBe(false);
    expect(result.embedding).toEqual(real);
  });

  it('lets a real fault through', async () => {
    const embed = withDegradedFallback(async () => {
      throw new TypeError('this is a bug, not a throttle');
    });

    await expect(embed('anything')).rejects.toThrow(TypeError);
  });
});

describe('a degraded intent skips dedupe and is marked', () => {
  it('runs no similarity search at all', async () => {
    const repoId = await session();
    const recorder = new StatementRecorder();

    await propose({
      repoId,
      agentId: 'agent-1',
      statement: 'add a retry to the orders client',
      resourceKeys: ['file:src/orders/client.ts'],
      embedding: degradedEmbedding('add a retry to the orders client'),
      degradedEmbedding: true,
      plane: 'demo',
      demoSession: repoId,
      recorder,
    });

    // The show-SQL panel is a transcript of what reached the driver (U16), so "dedupe was
    // skipped" is checkable against it rather than being a claim about a code path. A
    // threshold of zero would have been the lazy way to do this and it would have left the
    // search in the log, telling a judge the opposite of the truth.
    const searched = recorder.statements.filter((s) => s.sql.includes('<=>'));
    expect(searched, 'a degraded propose still ran a similarity search').toHaveLength(0);
  });

  it('still runs one for an ordinary propose — so the assertion above means something', async () => {
    const repoId = await session();
    const recorder = new StatementRecorder();

    await propose({
      repoId,
      agentId: 'agent-1',
      statement: 'add a retry to the orders client',
      resourceKeys: ['file:src/orders/client.ts'],
      embedding: degradedEmbedding('add a retry to the orders client'),
      plane: 'demo',
      demoSession: repoId,
      recorder,
    });

    const searched = recorder.statements.filter((s) => s.sql.includes('<=>'));
    expect(searched.length).toBeGreaterThan(0);
  });

  it('marks the row, so the marking survives a page reload', async () => {
    const repoId = await session();

    const result = await propose({
      repoId,
      agentId: 'agent-1',
      statement: 'add a retry to the orders client',
      resourceKeys: ['file:src/orders/client.ts'],
      embedding: degradedEmbedding('add a retry to the orders client'),
      degradedEmbedding: true,
      plane: 'demo',
      demoSession: repoId,
    });

    expect(result.decision).toBe('granted');

    const admin = new Client({
      connectionString: process.env.CORTEX_DSN,
      connectionTimeoutMillis: 10_000,
    });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ embedding_degraded: boolean }>(
        'SELECT embedding_degraded FROM intents WHERE repo_id = $1',
        [repoId],
      );
      // In the run result it is ephemeral; in the row it is a fact about the intent that
      // outlives the request that created it. §5 says "intent marked degraded", and an
      // in-memory flag is not a marked intent.
      expect(rows[0]?.embedding_degraded).toBe(true);
    } finally {
      await admin.end();
    }
  });

  it('leaves an ordinary intent unmarked', async () => {
    const repoId = await session();

    await propose({
      repoId,
      agentId: 'agent-1',
      statement: 'add a retry to the orders client',
      resourceKeys: ['file:src/orders/client.ts'],
      embedding: degradedEmbedding('add a retry to the orders client'),
      plane: 'demo',
      demoSession: repoId,
    });

    const admin = new Client({
      connectionString: process.env.CORTEX_DSN,
      connectionTimeoutMillis: 10_000,
    });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ embedding_degraded: boolean }>(
        'SELECT embedding_degraded FROM intents WHERE repo_id = $1',
        [repoId],
      );
      expect(rows[0]?.embedding_degraded).toBe(false);
    } finally {
      await admin.end();
    }
  });
});

describe('a degraded intent cannot poison later dedupe decisions', () => {
  it('is invisible to the next agent’s similarity search', async () => {
    const repoId = await session();
    const statement = 'add a retry to the orders client';
    const vector = degradedEmbedding(statement);

    // Written while Bedrock was down. Its vector is a hash and sits at an arbitrary
    // distance from every real embedding.
    await propose({
      repoId,
      agentId: 'agent-1',
      statement,
      resourceKeys: ['file:src/orders/client.ts'],
      embedding: vector,
      degradedEmbedding: true,
      plane: 'demo',
      demoSession: repoId,
    });

    // Bedrock is back. This agent's vector is real, and it happens to be identical here —
    // which is the strongest possible case for the degraded row being matched. It must not
    // be: a distance to a hash is not evidence of anything, and deduping on it would cancel
    // real work on the strength of a number that means nothing.
    const second = await propose({
      repoId,
      agentId: 'agent-2',
      statement,
      resourceKeys: ['file:src/orders/other.ts'],
      embedding: vector,
      plane: 'demo',
      demoSession: repoId,
    });

    expect(
      second.decision,
      'a degraded intent was used as a dedupe candidate — its distances are meaningless',
    ).toBe('granted');
  });

  it('still dedupes against an ordinary intent, so the exclusion is not a blanket', async () => {
    const repoId = await session();
    const statement = `keep the ${randomUUID()} orders client honest`;
    const vector = degradedEmbedding(statement);

    await propose({
      repoId,
      agentId: 'agent-1',
      statement,
      resourceKeys: ['file:src/orders/client.ts'],
      embedding: vector,
      plane: 'demo',
      demoSession: repoId,
    });

    const second = await propose({
      repoId,
      agentId: 'agent-2',
      statement,
      resourceKeys: ['file:src/orders/other.ts'],
      embedding: vector,
      plane: 'demo',
      demoSession: repoId,
    });

    expect(second.decision).toBe('deduped');
  });
});

/**
 * `04` §5 invariant 4: "Every rung MUST be verified by forcing its limit, not by reasoning
 * about it." These force it against the real cluster — the embedder throttles every call and
 * the run has to come back as a page rather than as an exception.
 *
 * `npm run gate:degrade` is the same forcing, reproducible from a terminal, and it is what
 * U17's done-when means by "each rung forced deliberately".
 */
describe('rung 2 forced — the run degrades and still produces a page', () => {
  const healthy = async (text: string): Promise<number[]> => degradedEmbedding(text);
  const throttled = async (): Promise<number[]> => {
    throw Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });
  };

  it('completes every beat with Bedrock refusing every call', async () => {
    const sessionId = await session();

    const result = await runScenario({ sessionId, arm: 'cortex', embed: throttled });

    // The load-bearing assertion is that this line is reached at all. §5 invariant 1 admits
    // no error page on any path a visitor can reach, and rung 2 is the one §5 says will fire
    // unnoticed — so the failure mode being guarded is a 500 behind the run button.
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.degraded?.rung).toBe(2);
    expect(result.degraded?.embeddings).toBeGreaterThan(0);
  }, 60_000);

  it('says what degraded and what did not', async () => {
    const sessionId = await session();
    const result = await runScenario({ sessionId, arm: 'cortex', embed: throttled });

    const reason = result.degraded?.reason ?? '';
    // Invariant 2 in both directions: it must not hide the degradation, and it must not
    // imply the database went with it.
    expect(reason).toMatch(/dedupe/i);
    expect(reason).toMatch(/CockroachDB|database/i);
  }, 60_000);

  it('marks every intent it wrote, so the panel and the next query agree', async () => {
    const sessionId = await session();
    await runScenario({ sessionId, arm: 'cortex', embed: throttled });

    const admin = new Client({
      connectionString: process.env.CORTEX_DSN,
      connectionTimeoutMillis: 10_000,
    });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ n: string }>(
        'SELECT count(*)::INT AS n FROM intents WHERE repo_id = $1 AND NOT embedding_degraded',
        [sessionId],
      );
      expect(Number(rows[0]?.n), 'an intent written on a hash vector was left unmarked').toBe(0);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('carries no degraded block when nothing degraded', async () => {
    const sessionId = await session();

    const result = await runScenario({ sessionId, arm: 'cortex', embed: healthy });

    // An always-present banner is a banner nobody reads. The ordinary run says nothing about
    // rungs because it is not standing on one.
    expect(result.degraded).toBeUndefined();
  }, 60_000);
});
