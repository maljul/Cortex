/**
 * THE CHANGE STREAM — what arrives from the cluster's own changefeed, and who may see it.
 * spec/04-ARCHITECTURE.md §2 and flow E, spec/05-INTERFACES.md §5.
 *
 * Flow E's point is that the demo panel shows **what committed**, not what the
 * application believes it sent. That only holds if this path stays a translation of the
 * database's own emissions, so nothing here invents, enriches or reorders an event.
 *
 * Kept out of `infra/lambda/` for the usual reason: a receiver that can only be
 * exercised by pointing a changefeed at it is a receiver that is exercised once.
 */
import { timingSafeEqual } from 'node:crypto';

/** One row change, as CockroachDB's webhook sink emits it. */
export interface ChangeEvent {
  topic: string;
  key: unknown[];
  after: Record<string, unknown> | null;
  updated?: string;
}

/**
 * CockroachDB's webhook envelope: `{"payload": [...], "length": n}`, plus periodic
 * `{"resolved": "<timestamp>"}` messages when the feed is created with `resolved`.
 *
 * A resolved message carries no rows and yields none. It is not an error and must not be
 * treated as one — dropping it on the floor is the correct handling, and the sink still
 * has to answer 200 or the changefeed job retries and eventually fails.
 */
export function parseChangefeedPayload(body: unknown): ChangeEvent[] {
  if (body === null || typeof body !== 'object') return [];

  const envelope = body as { payload?: unknown; resolved?: unknown };
  if (!Array.isArray(envelope.payload)) return [];

  return envelope.payload.flatMap((entry): ChangeEvent[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    if (typeof row['topic'] !== 'string') return [];

    return [
      {
        topic: row['topic'],
        key: Array.isArray(row['key']) ? row['key'] : [],
        after: (row['after'] ?? null) as Record<string, unknown> | null,
        ...(typeof row['updated'] === 'string' ? { updated: row['updated'] } : {}),
      },
    ];
  });
}

/**
 * The `repo_id` an event belongs to, or `null` when it carries none.
 *
 * `null` is the answer for a delete — the sink emits `after: null` — and for any row
 * shape this code did not expect. Both are dropped by the caller rather than broadcast,
 * because an event whose tenant cannot be established is exactly the one that must not
 * be sent anywhere.
 */
export function scopeOf(event: ChangeEvent): string | null {
  const repoId = event.after?.['repo_id'];
  return typeof repoId === 'string' ? repoId : null;
}

/**
 * The row as it goes on the wire, with embedding columns dropped.
 *
 * A `findings` or `intents` row carries a `VECTOR(1024)`, which the sink serialises as a
 * ~20KB string of zeroes and decimals. Nothing on the demo panel renders it, so pushing
 * it to every listening browser costs two orders of magnitude in message size for no
 * pixel. Measured on U14's first end-to-end delivery, which arrived carrying the whole
 * vector.
 *
 * **This is the only thing the fan-out removes**, and it is named rather than done
 * quietly: flow E's claim is that the panel shows what committed, so a path that edited
 * values on the way through would falsify the one property the change stream exists to
 * have. Dropping a field the interface does not display is a projection; changing one
 * would be a lie. Nothing else is added, renamed or reordered.
 */
export function forTransport(
  after: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (after === null) return null;

  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === 'embedding') continue;
    projected[key] = value;
  }
  return projected;
}

/**
 * Constant-time comparison of the changefeed's `webhook_auth_header` against the value
 * this deployment expects.
 *
 * The sink is a public HTTPS route — it has to be, because CockroachDB Cloud reaches it
 * from outside the account — so without this anyone could post fabricated rows and watch
 * them appear on the demo's live panel as though the database had emitted them. That is
 * `04` §5 invariant 2's misrepresentation of liveness, arrived at from the other end.
 */
export function isAuthorizedChangefeed(
  presented: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
