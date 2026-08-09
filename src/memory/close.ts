/**
 * CLOSE — outcome, ledger and release in one transaction.
 * spec/03-MEMORY-MODEL.md §4.3, spec/05-INTERFACES.md §3 `cortex_close`.
 *
 * The finding is deliberately not written here. Consolidation produces it
 * asynchronously off a changefeed (§4.4), so a slow embedding call never sits on
 * the agent's critical path.
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { withRetry } from '../db/retry.js';

/** What the agent reports. `reverted` is an outcome, not a status — see below. */
export type CloseResultKind = 'done' | 'abandoned' | 'reverted';

/** The two terminal values `intents.status` is allowed to take (§4.3). */
export type ClosedStatus = 'done' | 'abandoned';

/** The default `action_ledger.action` for the close itself. */
const CLOSE_ACTION = 'close_intent';

export interface CloseInput {
  repoId: string;
  intentId: string;
  result: CloseResultKind;
  /** Unique per repo. A redelivered tool call MUST carry the same one. */
  idempotencyKey: string;
  filesChanged?: readonly string[];
  notes?: string;
  tokensSpent?: number;
  action?: string;
}

export interface CloseOutput {
  /** False when this call was a redelivery of one already applied. */
  applied: boolean;
  intentId: string;
  status: ClosedStatus;
  releasedKeys: number;
}

/**
 * A close that cannot be applied and is not a retry: an unknown intent, an intent
 * belonging to another repo, a second close of an already-closed intent, or an
 * idempotency key already spent by a different intent.
 *
 * These are caller bugs, not contention, so unlike `blocked` and `deduped` in
 * `propose` they are exceptions rather than return values (05-INTERFACES.md §1:
 * exceptions are reserved for things that are genuinely wrong).
 */
export class CloseError extends Error {}

/**
 * `reverted` is not a status value.
 *
 * The `intents.status` CHECK admits only proposed | in_flight | done | abandoned |
 * deduped, and §4.3 writes the close as 'done' | 'abandoned'. A revert means the
 * work was applied and then undone, so the intent did reach completion — and it
 * must, because consolidation (§4.4) fires on the transition to 'done', and §4.1's
 * `times_reverted` column can only count reverts that reached a finding. Mapping
 * `reverted` onto 'abandoned' would make that column permanently zero and silently
 * delete the single most useful signal recall has.
 */
function statusFor(result: CloseResultKind): ClosedStatus {
  return result === 'abandoned' ? 'abandoned' : 'done';
}

/** Stable digest of the effect payload, so a retry under a mutated payload is visible. */
function digestOf(outcome: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
}

/**
 * Claims the idempotency key, or reports who already holds it.
 *
 * The ledger insert runs *first*, ahead of the UPDATE and DELETE that §4.3 lists
 * before it. Reordering inside a single snapshot changes nothing for a first
 * delivery, and it promotes the UNIQUE (repo_id, idempotency_key) index from a
 * guard on one row to the gate for the whole operation — which is what invariant 4
 * actually asks for. "The effect" is the close, not the ledger row.
 */
async function claimIdempotencyKey(
  client: PoolClient,
  repoId: string,
  intentId: string,
  idempotencyKey: string,
  action: string,
  digest: string,
): Promise<{ fresh: true } | { fresh: false; heldBy: string }> {
  const { rows: inserted } = await client.query(
    `INSERT INTO action_ledger (repo_id, intent_id, idempotency_key, action, payload_digest)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (repo_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [repoId, intentId, idempotencyKey, action, digest],
  );

  if (inserted.length === 1) return { fresh: true };

  const { rows: existing } = await client.query(
    'SELECT intent_id FROM action_ledger WHERE repo_id = $1 AND idempotency_key = $2',
    [repoId, idempotencyKey],
  );
  return { fresh: false, heldBy: (existing[0] as { intent_id: string }).intent_id };
}

/**
 * Records the outcome of an intent, spends its idempotency key and releases every
 * claim it holds — all on one snapshot.
 *
 * Idempotent by contract: a redelivery of the same key against the same intent is
 * a no-op that reports `applied: false`. It is not idempotent across *different*
 * keys; a genuine second close of a closed intent throws, because that is a caller
 * that lost track of its own work rather than a network that duplicated a message.
 */
export async function close(input: CloseInput): Promise<CloseOutput> {
  const {
    repoId,
    intentId,
    result,
    idempotencyKey,
    filesChanged,
    notes,
    tokensSpent = 0,
    action = CLOSE_ACTION,
  } = input;

  const status = statusFor(result);
  const outcome: Record<string, unknown> = { result };
  if (filesChanged !== undefined) outcome.files_changed = [...filesChanged];
  if (notes !== undefined) outcome.notes = notes;

  return withRetry(async (client) => {
    const key = await claimIdempotencyKey(
      client,
      repoId,
      intentId,
      idempotencyKey,
      action,
      digestOf(outcome),
    );

    if (!key.fresh) {
      if (key.heldBy !== intentId) {
        throw new CloseError(
          `idempotency key ${JSON.stringify(idempotencyKey)} was already spent by intent ` +
            `${key.heldBy}. Keys are unique per repo; a redelivery must reuse the key of ` +
            'the call it repeats, and a new call must mint a new one.',
        );
      }

      // A redelivery. Report the state the first delivery left behind, touch nothing.
      const { rows } = await client.query(
        'SELECT status FROM intents WHERE id = $1 AND repo_id = $2',
        [intentId, repoId],
      );
      const already = rows[0] as { status: string } | undefined;

      return {
        applied: false,
        intentId,
        status: (already?.status ?? status) as ClosedStatus,
        releasedKeys: 0,
      };
    }

    // Only an in-flight intent may be closed. Restricting the UPDATE this way makes
    // one statement answer three questions — does it exist, is it ours, is it still
    // open — and rolls the whole transaction back, ledger row included, if not.
    const { rowCount: closed } = await client.query(
      `UPDATE intents
          SET status = $3, outcome = $4, tokens_spent = $5, closed_at = now()
        WHERE id = $1 AND repo_id = $2 AND status = 'in_flight'`,
      [intentId, repoId, status, JSON.stringify(outcome), tokensSpent],
    );

    if (closed !== 1) throw new CloseError(await explainFailure(client, repoId, intentId));

    // Release. §1: a dead agent releases nothing by hand and waits for the TTL job,
    // but a live agent that finished should not make the next one wait for a sweep.
    const { rowCount: released } = await client.query(
      'DELETE FROM claims WHERE repo_id = $1 AND intent_id = $2',
      [repoId, intentId],
    );

    return { applied: true, intentId, status, releasedKeys: released ?? 0 };
  });
}

/**
 * Turns a refused close into a message that names the actual cause — within this
 * repo, and only within it.
 *
 * The `repo_id` filter is not defensive tidiness, it is invariant 5: every read
 * carries it. An earlier version read `WHERE id = $1` alone so it could say
 * "belongs to another repo", which reads as a better error and is in fact an
 * existence oracle — it lets a caller probe whether an arbitrary UUID names an
 * intent in some tenant it cannot see, off a read that crossed the boundary to
 * find out. Wrong repo and no such intent are therefore one message. Repo B
 * learns that the id is not one of its own, which it knew before it asked.
 */
async function explainFailure(
  client: PoolClient,
  repoId: string,
  intentId: string,
): Promise<string> {
  const { rows } = await client.query(
    'SELECT status FROM intents WHERE id = $1 AND repo_id = $2',
    [intentId, repoId],
  );
  const intent = rows[0] as { status: string } | undefined;

  if (!intent) return `no intent ${intentId} in this repo`;
  return `intent ${intentId} is already ${intent.status}; close is called exactly once per intent`;
}
