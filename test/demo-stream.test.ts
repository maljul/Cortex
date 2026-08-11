/**
 * THE CHANGE STREAM — spec/04-ARCHITECTURE.md flow E, spec/05-INTERFACES.md §5.
 *
 * The interesting assertions here are the two refusals. A changefeed emits every row in
 * the tables it watches, and the sink is a public HTTPS route that CockroachDB Cloud
 * reaches from outside the account, so the fan-out is the one place in this project
 * where real repository memory and an anonymous listener are separated by application
 * code rather than by a grant. Both directions are tested: nothing unauthorised gets
 * *in*, and nothing outside a live demo scope gets *out*.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { closePool } from '../src/db/pool.js';
import {
  forTransport,
  isAuthorizedChangefeed,
  parseChangefeedPayload,
  scopeOf,
} from '../src/demo/stream.js';
import { createDemoSession, isLiveDemoScope } from '../src/memory/demo.js';

afterAll(async () => {
  await closePool();
});

describe('parsing what the webhook sink actually sends', () => {
  /** The envelope from CockroachDB's own documentation, shortened. */
  const envelope = {
    payload: [
      {
        after: { id: 'i1', repo_id: 'r1', status: 'done' },
        key: ['r1', 'i1'],
        topic: 'intents',
        updated: '1629813621680097993.0000000000',
      },
    ],
    length: 1,
  };

  it('reads a row change out of the envelope', () => {
    const events = parseChangefeedPayload(envelope);
    expect(events).toHaveLength(1);
    expect(events[0]?.topic).toBe('intents');
    expect(scopeOf(events[0]!)).toBe('r1');
  });

  it('yields nothing for a resolved message, and does not treat it as an error', () => {
    expect(parseChangefeedPayload({ resolved: '1629813621680097993.0000000000' })).toEqual([]);
  });

  it('yields no scope for a delete, which carries no row to attribute', () => {
    const [event] = parseChangefeedPayload({
      payload: [{ after: null, key: ['r1', 'i1'], topic: 'intents' }],
      length: 1,
    });
    expect(scopeOf(event!)).toBeNull();
  });

  it('drops the embedding on the way out, and nothing else', () => {
    const after = { id: 'i1', repo_id: 'r1', fact: 'x', embedding: '[0,0,0]', confidence: 0.5 };
    expect(forTransport(after)).toEqual({ id: 'i1', repo_id: 'r1', fact: 'x', confidence: 0.5 });
    expect(forTransport(null)).toBeNull();
  });

  it('survives a body that is not an envelope at all', () => {
    for (const body of [null, 'nonsense', 42, {}, { payload: 'not an array' }]) {
      expect(parseChangefeedPayload(body)).toEqual([]);
    }
  });
});

describe('the sink refuses anything it cannot authenticate', () => {
  it('accepts only the exact expected header', () => {
    expect(isAuthorizedChangefeed('Bearer abc', 'Bearer abc')).toBe(true);
    expect(isAuthorizedChangefeed('Bearer abd', 'Bearer abc')).toBe(false);
    expect(isAuthorizedChangefeed('Bearer abc ', 'Bearer abc')).toBe(false);
  });

  /**
   * The failure that matters is an *unconfigured* deployment silently accepting
   * everything, which is how a public route ends up taking fabricated rows and
   * displaying them on a panel that claims to show what the database committed.
   */
  it('refuses when either side is missing rather than defaulting open', () => {
    expect(isAuthorizedChangefeed(undefined, 'Bearer abc')).toBe(false);
    expect(isAuthorizedChangefeed('Bearer abc', undefined)).toBe(false);
    expect(isAuthorizedChangefeed(undefined, undefined)).toBe(false);
    expect(isAuthorizedChangefeed('', '')).toBe(false);
  });
});

describe('the fan-out establishes the scope before it broadcasts', () => {
  it('says yes to a live demo scope', async () => {
    const session = await createDemoSession();
    try {
      expect(await isLiveDemoScope(session.sessionId)).toBe(true);
    } finally {
      const admin = new Client({
        connectionString: process.env.CORTEX_DSN,
        connectionTimeoutMillis: 10_000,
      });
      await admin.connect();
      await admin.query('DELETE FROM repos WHERE id = $1', [session.sessionId]);
      await admin.end();
    }
  });

  /**
   * The leak this whole check exists to stop: a changefeed on `intents` emits real
   * repositories' rows too, so a listener that named a real repository's id would be
   * handed real memory by a path that never touches `04` §3's confinement.
   */
  it('says no to a real repository, and to an id that is nothing at all', async () => {
    const admin = new Client({
      connectionString: process.env.CORTEX_DSN,
      connectionTimeoutMillis: 10_000,
    });
    await admin.connect();

    const slug = `demo-stream-test/real-${randomUUID()}`;
    const { rows } = await admin.query<{ id: string }>(
      'INSERT INTO repos (slug) VALUES ($1) RETURNING id',
      [slug],
    );

    try {
      expect(await isLiveDemoScope(rows[0]!.id)).toBe(false);
      expect(await isLiveDemoScope(randomUUID())).toBe(false);
    } finally {
      await admin.query('DELETE FROM repos WHERE id = $1', [rows[0]!.id]);
      await admin.end();
    }
  });

  it('says no to an expired scope, at the instant it expires', async () => {
    // One second of life, then gone. Expiry is enforced by the policy predicate at read
    // time rather than by a cleanup job, which is what `04` §3 relies on for a demo that
    // must survive unattended until 2026-09-15.
    const session = await createDemoSession(1);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await isLiveDemoScope(session.sessionId)).toBe(false);
    } finally {
      const admin = new Client({
        connectionString: process.env.CORTEX_DSN,
        connectionTimeoutMillis: 10_000,
      });
      await admin.connect();
      await admin.query('DELETE FROM repos WHERE id = $1', [session.sessionId]);
      await admin.end();
    }
  });
});
