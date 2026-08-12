/**
 * DEMO SESSION SCOPES — the hosted demo's tenant, and what it can see of itself.
 * spec/03-MEMORY-MODEL.md §7, spec/05-INTERFACES.md §5, spec/04-ARCHITECTURE.md §3.
 *
 * A demo session is a repository like any other, distinguished by exactly one column:
 * `repos.demo_expires_at`. NULL means a real repository and is what makes it unreachable
 * to `cortex_demo`; a timestamp makes the scope live until it passes. Everything else
 * here — the claims, the intents, the findings — is ordinary tenant data reached through
 * the same `repo_id` scoping every other read in this project carries.
 *
 * **Why the reads below filter on `repo_id` when row-level security would already do
 * it.** Invariant 5 is not "rows from another tenant must not come back"; it is "every
 * read carries `WHERE repo_id`", because V5 measured what the alternative costs. A query
 * that leans on the policy is correct only for as long as the policy is, and it would
 * keep passing every behavioural test while it stopped being correct. Two independent
 * mechanisms, and the SQL is asserted directly in `test/demo-plane.test.ts`.
 */
import { randomUUID } from 'node:crypto';

import type { Plane } from '../db/pool.js';
import type { StatementRecorder } from '../db/recorder.js';
import { withRetry } from '../db/retry.js';

/**
 * How long a demo session's scope stays live.
 *
 * `03` §7 requires an expiry and does not name one. An hour is chosen against the
 * visitor this is built for: a judge who opens the demo, reads four beats, and clicks
 * through them. Long enough that nothing goes dark mid-read, short enough that an
 * abandoned session stops being reachable the same afternoon. Expiry is enforced at read
 * time by the policy predicate, so this is also the window in which a leaked session id
 * is worth anything at all.
 */
export const DEMO_SESSION_TTL_SECONDS = 60 * 60;

/**
 * The per-session row budget `03` §7 requires. Reaching it makes that session read-only
 * — never an error, and never anything another session can feel.
 *
 * 200 is sized off the demo rather than off the cluster: the four beats of `07` §3 write
 * on the order of tens of rows, so this is roughly an order of magnitude of headroom for
 * a visitor who keeps clicking, and still small enough that a scripted abuser fills one
 * session and gets a read-only page rather than a bill.
 *
 * **Enforcement is not in this unit.** U14 builds the surface that *reports* the budget,
 * which is what `05` §5 requires so the SPA can render a degraded state truthfully. The
 * routes that consume budget arrive with the SPA, and rung 3 is forced deliberately in
 * U17. Nothing here claims the cap is applied; `remaining` is a number to display.
 */
export const DEMO_SESSION_ROW_CAP = 200;

/**
 * The five tables a session's rows can accumulate in. `repos` is excluded on purpose:
 * the scope's own row is the session, not something the session spent its budget on.
 */
const COUNTED_TABLES = ['agents', 'claims', 'intents', 'findings', 'action_ledger'] as const;

/**
 * What the page says about its own liveness, per `07` §4's honesty rule.
 *
 * §4 prescribes the literal line "replay mode: agent reasoning is cached, all database
 * behaviour is live", and this deployment **must not** ship that wording: the scenario
 * performs no model reasoning at all, so there is nothing cached and claiming otherwise
 * would be exactly the misrepresentation A7 and the honesty rule exist to prevent. The
 * embeddings that drive dedupe *are* live Bedrock calls, which is worth saying because it
 * is the part a sceptic would assume was faked.
 *
 * Recorded against `07` §4 in `docs/SPEC-DELTA.md`. When U17 builds the LIVE reasoning path
 * and its quota rung, this becomes a real two-value mode and §4's wording becomes correct.
 */
const DEMO_MODE = {
  name: 'live database, live embeddings',
  reason:
    'Every row on this page was committed by CockroachDB and arrived over its own ' +
    'changefeed. Dedupe distances come from live Bedrock embeddings. This scenario ' +
    'performs no model reasoning, so nothing here is replayed from a cassette.',
} as const;

export const DEMO_CLAIMS_SQL = `
  SELECT resource_key, holder, intent_id, acquired_at, expires_at
    FROM claims
   WHERE repo_id = $1
   ORDER BY acquired_at DESC
`;

export const DEMO_INTENTS_SQL = `
  SELECT id, agent_id, statement, status, deduped_of, created_at, closed_at
    FROM intents
   WHERE repo_id = $1
   ORDER BY created_at DESC
   LIMIT 50
`;

export const DEMO_FINDINGS_SQL = `
  SELECT id, fact, confidence, corroborations, contradictions, last_confirmed_at
    FROM findings
   WHERE repo_id = $1
   ORDER BY last_confirmed_at DESC
   LIMIT 50
`;

/**
 * Procedural memory — `03` §2's fourth tier, and the one `07` §2's memory panel had no
 * source for until U16. The idempotency key is the interesting column on screen: it is
 * what makes a retried tool call safe, and it is a real value rather than a description
 * of one.
 */
export const DEMO_LEDGER_SQL = `
  SELECT id, intent_id, idempotency_key, action, applied_at
    FROM action_ledger
   WHERE repo_id = $1
   ORDER BY applied_at DESC
   LIMIT 50
`;

/**
 * Which of these agents still has the work it was granted, recorded against this session.
 *
 * The CORTEX half of the demo's `writes lost` row. `06` §6 draws a hard line between "no
 * such thing to measure" and "measured as nought", and a bare 0 written into that cell
 * would be neither — so the arm is asked the same question the NAIVE arm is asked, and
 * answers it by reading the database back: of the work you acknowledged, how much is still
 * there and still yours? Arbitration is the reason the answer is all of it, and the
 * subtraction that produces the zero is over two counted quantities.
 *
 * `deduped` is excluded because a deduped agent never acquired work to lose; `abandoned`
 * is excluded because abandoning is a decision, not a loss.
 */
export const DEMO_SURVIVING_WORK_SQL = `
  SELECT DISTINCT agent_id
    FROM intents
   WHERE repo_id = $1
     AND agent_id = ANY($2::STRING[])
     AND status IN ('in_flight', 'done')
`;

/**
 * The NAIVE arm's shared work cell, for the memory panel.
 *
 * `07` §2's centre panel renders `03` §2's four tiers, and after a NAIVE run all four are
 * legitimately empty — which reads as a failure rather than as the result unless the panel
 * can show what that fleet *does* have. This is it: one JSON cell holding whatever survived
 * the last write. Put side by side with four populated tiers, the contrast is visible
 * rather than described, which is what `07` §2 asks the toggle to do.
 */
export const DEMO_SHARED_STATE_SQL = `
  SELECT demo_shared_state
    FROM repos
   WHERE id = $1
`;

export const DEMO_ROW_COUNT_SQL = `
  SELECT ${COUNTED_TABLES.map((t) => `(SELECT count(*) FROM ${t} WHERE repo_id = $1)`).join(' + ')}
         AS used
`;

const DEMO_SESSION_INSERT_SQL = `
  INSERT INTO repos (id, slug, demo_expires_at)
  VALUES ($1, $2, $3)
  RETURNING id, slug, demo_expires_at
`;

const DEMO_SESSION_LOOKUP_SQL = `
  SELECT id, demo_expires_at
    FROM repos
   WHERE id = $1
`;

export interface DemoSession {
  sessionId: string;
  slug: string;
  expiresAt: Date;
}

export interface DemoClaim {
  resourceKey: string;
  holder: string;
  intentId: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export interface DemoIntent {
  id: string;
  agentId: string;
  statement: string;
  status: string;
  dedupedOf: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

export interface DemoLedgerEntry {
  id: string;
  intentId: string;
  idempotencyKey: string;
  action: string;
  appliedAt: Date;
}

/** One entry as `src/memory/shared-state.ts` stores it. Read here, never written here. */
interface SharedEntryRow {
  agent: string;
  statement: string;
  note: string;
}

export interface DemoFinding {
  id: string;
  fact: string;
  confidence: number;
  corroborations: number;
  contradictions: number;
  lastConfirmedAt: Date;
}

export interface DemoState {
  session: { sessionId: string; expiresAt: Date };
  claims: DemoClaim[];
  intents: DemoIntent[];
  findings: DemoFinding[];
  ledger: DemoLedgerEntry[];
  /**
   * Everything the NAIVE arm has instead of the four tiers above, and `null` for every
   * CORTEX session because that arm never writes it. See `DEMO_SHARED_STATE_SQL`.
   */
  sharedState: { entries: { agent: string; statement: string; note: string }[] } | null;
  rows: { used: number; cap: number; remaining: number };
  /**
   * What the interface must be able to say about itself, per `05` §5: "The current mode,
   * the reason for it, and the session's remaining row budget MUST be readable by the SPA,
   * so that the interface can render a degraded state truthfully instead of discovering it
   * through a failed request."
   */
  mode: { name: string; reason: string };
}

/**
 * Creates a sandbox scope and returns its id.
 *
 * The id is generated here and set as the connection's scope *before* the INSERT, which
 * is what `05` §5 prescribes and is not merely an ordering preference: `repos` carries
 * the same policy as everything else, so the scope's own row is subject to it. An INSERT
 * issued before the scope is set fails its `WITH CHECK` — the demo cannot mint a
 * repository it is not already claiming to be.
 *
 * A write, so it goes through `withRetry` (invariant 6). Nothing about it is likely to
 * see a 40001; the helper is not optional on the strength of being unlikely.
 */
export async function createDemoSession(
  ttlSeconds: number = DEMO_SESSION_TTL_SECONDS,
): Promise<DemoSession> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const row = await withRetry(
    async (client) => {
      const { rows } = await client.query<{ id: string; slug: string; demo_expires_at: Date }>(
        DEMO_SESSION_INSERT_SQL,
        [sessionId, `demo/${sessionId}`, expiresAt],
      );
      return rows[0];
    },
    { plane: 'demo', demoSession: sessionId },
  );

  if (!row) {
    throw new Error('demo session insert returned no row');
  }

  return { sessionId: row.id, slug: row.slug, expiresAt: row.demo_expires_at };
}

/**
 * Whether `repoId` names a demo scope that has not expired.
 *
 * Asked by *attempting the read as `cortex_demo`*, scoped to that id, rather than by
 * consulting `demo_expires_at` as an administrator. The answer is then the policy's own
 * answer — the same predicate that governs every other statement the demo plane issues —
 * so this cannot drift away from the boundary it is reporting on.
 *
 * The change stream is what needs it. A changefeed on a table emits every row in that
 * table, real repositories included, so the fan-out has to establish that an event
 * belongs to a demo scope before it puts it on a socket. Without this check a listener
 * that named a real repository's id would be handed real repository memory by a path
 * that never touches `04` §3's confinement at all.
 */
export async function isLiveDemoScope(repoId: string): Promise<boolean> {
  return withRetry(
    async (client) => {
      const { rows } = await client.query(DEMO_SESSION_LOOKUP_SQL, [repoId]);
      return rows.length === 1;
    },
    { plane: 'demo', demoSession: repoId },
  );
}

/**
 * The agents from `agentIds` whose granted work is still recorded in this session.
 *
 * See `DEMO_SURVIVING_WORK_SQL`. Carries `WHERE repo_id` like every other read here, per
 * invariant 5, rather than leaning on the policy that would also enforce it.
 */
export async function survivingWork(
  sessionId: string,
  agentIds: readonly string[],
  options: { plane?: Plane; recorder?: StatementRecorder } = {},
): Promise<string[]> {
  if (agentIds.length === 0) return [];

  return withRetry(
    async (client) => {
      const { rows } = await client.query<{ agent_id: string }>(DEMO_SURVIVING_WORK_SQL, [
        sessionId,
        agentIds,
      ]);
      return rows.map((row) => row.agent_id);
    },
    {
      plane: options.plane ?? 'demo',
      demoSession: sessionId,
      ...(options.recorder ? { recorder: options.recorder } : {}),
    },
  );
}

/**
 * Everything the demo panel shows for one session, or `null` when the id names anything
 * that is not a live demo scope.
 *
 * `null` rather than an error, and the route above turns it into a 404 rather than a
 * failure page: `04` §5 invariant 1 admits no error page on any path a visitor can reach,
 * and an expired session is a limit being reached, not a fault. It is also the answer
 * for a real repository's id offered as though it were a session — the policy simply
 * matches nothing, which is the case `04` §3 turns on.
 *
 * Read-only, but it runs through `withRetry` because the scope has to be set inside a
 * transaction to be transaction-local, and every statement here must run under the same
 * scope as the lookup that validated it.
 */
export async function demoState(sessionId: string): Promise<DemoState | null> {
  return withRetry(
    async (client) => {
      const scope = await client.query<{ id: string; demo_expires_at: Date }>(
        DEMO_SESSION_LOOKUP_SQL,
        [sessionId],
      );
      const session = scope.rows[0];
      if (!session) return null;

      // Sequential, not `Promise.all`: these four share one pooled client, and a client
      // cannot run two statements at once. `pg` warns rather than failing, which makes
      // this the kind of mistake that works in a test and interleaves in production.
      const claims = await client.query(DEMO_CLAIMS_SQL, [sessionId]);
      const intents = await client.query(DEMO_INTENTS_SQL, [sessionId]);
      const findings = await client.query(DEMO_FINDINGS_SQL, [sessionId]);
      const ledger = await client.query(DEMO_LEDGER_SQL, [sessionId]);
      const shared = await client.query<{
        demo_shared_state: { completed?: Record<string, SharedEntryRow> } | null;
      }>(DEMO_SHARED_STATE_SQL, [sessionId]);
      const counted = await client.query<{ used: string }>(DEMO_ROW_COUNT_SQL, [sessionId]);

      const used = Number(counted.rows[0]?.used ?? 0);
      const completed = shared.rows[0]?.demo_shared_state?.completed;

      return {
        session: { sessionId: session.id, expiresAt: session.demo_expires_at },
        claims: claims.rows.map((r) => ({
          resourceKey: r.resource_key,
          holder: r.holder,
          intentId: r.intent_id,
          acquiredAt: r.acquired_at,
          expiresAt: r.expires_at,
        })),
        intents: intents.rows.map((r) => ({
          id: r.id,
          agentId: r.agent_id,
          statement: r.statement,
          status: r.status,
          dedupedOf: r.deduped_of,
          createdAt: r.created_at,
          closedAt: r.closed_at,
        })),
        findings: findings.rows.map((r) => ({
          id: r.id,
          fact: r.fact,
          confidence: r.confidence,
          corroborations: Number(r.corroborations),
          contradictions: Number(r.contradictions),
          lastConfirmedAt: r.last_confirmed_at,
        })),
        ledger: ledger.rows.map((r) => ({
          id: r.id,
          intentId: r.intent_id,
          idempotencyKey: r.idempotency_key,
          action: r.action,
          appliedAt: r.applied_at,
        })),
        sharedState: completed
          ? {
              entries: Object.values(completed).map((entry) => ({
                agent: entry.agent,
                statement: entry.statement,
                note: entry.note,
              })),
            }
          : null,
        rows: {
          used,
          cap: DEMO_SESSION_ROW_CAP,
          remaining: Math.max(0, DEMO_SESSION_ROW_CAP - used),
        },
        mode: DEMO_MODE,
      };
    },
    { plane: 'demo', demoSession: sessionId },
  );
}
