/**
 * Repository identity — slug to `repo_id`. spec/03-MEMORY-MODEL.md §2, `05` §6.
 *
 * `repo_id` is the tenant boundary: invariant 5 puts a `WHERE repo_id` on every
 * read, and `claims` derives mutual exclusion from the uniqueness of
 * `(repo_id, resource_key)`. Everything before U8 was handed that UUID by its
 * caller. The MCP tool surface is not — `05` §6 gives an agent `CORTEX_REPO`, a
 * slug — so this is the first code that derives the boundary rather than receiving
 * it, and getting it wrong does not produce an error. Two agents on one repository
 * that resolve to two ids never see each other's claims, and both are granted.
 */
import { getPool } from '../db/pool.js';
import { withRetry } from '../db/retry.js';

export class RepoIdentityError extends Error {}

/**
 * Canonicalises a repo slug: trimmed and lowercased.
 *
 * Case is folded, unlike the path body of a resource key in `keys.ts`. The reason
 * they differ is what a collision costs on each side. Two spellings of one file
 * genuinely are two files on a case-sensitive checkout, so folding there would
 * merge distinct resources. Two spellings of one remote are one repository
 * everywhere the slug comes from, so *not* folding here would split one tenant in
 * two — and a split tenant has no mutual exclusion at all.
 */
export function canonicalSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();

  if (slug === '') {
    throw new RepoIdentityError('repo must not be empty; it is the tenant boundary');
  }

  return slug;
}

async function lookup(slug: string): Promise<string | undefined> {
  // Equality, never a pattern. This read is the tenant lookup itself, so a loose
  // match here hands a caller another tenant's boundary and every `WHERE repo_id`
  // downstream then filters correctly against the wrong repository.
  const { rows } = await getPool().query('SELECT id FROM repos WHERE slug = $1', [slug]);
  return (rows[0] as { id: string } | undefined)?.id;
}

/**
 * Resolves a slug to its `repo_id`, or fails if the repository is unknown.
 *
 * The counterpart to `resolveRepoId` for surfaces that must not register anything.
 * A close, a heartbeat or a release can never legitimately be the first thing a
 * repository ever sees, so an unrecognised slug there is a typo — and registering
 * it would mint an empty tenant and then report "no such intent in this repo",
 * which sends the caller looking for the wrong bug entirely.
 */
export async function requireRepoId(rawSlug: string): Promise<string> {
  const slug = canonicalSlug(rawSlug);
  const known = await lookup(slug);

  if (known === undefined) {
    throw new RepoIdentityError(
      `unknown repo ${JSON.stringify(slug)}. A repository is registered by its first ` +
        'cortex_propose; nothing can be closed in one that has never proposed.',
    );
  }

  return known;
}

/**
 * Resolves a slug to its `repo_id`, registering the repository on first sight.
 *
 * Idempotent, and safe to call concurrently: `repos.slug` is UNIQUE, so a fleet
 * attaching at once produces one row and one id. The insert goes through
 * `withRetry` because it is a write and invariant 6 admits no exceptions — and this
 * is the write most likely to see a 40001, being the single row every agent in a
 * fleet touches in its first second.
 *
 * Deliberately not folded into the arbitration transaction in `propose.ts`. It is
 * not part of the all-or-nothing claim set, and putting a contended row inside the
 * transaction that must stay small would manufacture serialization conflicts on the
 * critical path of every proposal.
 */
export async function resolveRepoId(rawSlug: string): Promise<string> {
  const slug = canonicalSlug(rawSlug);

  const known = await lookup(slug);
  if (known !== undefined) return known;

  const inserted = await withRetry(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO repos (slug) VALUES ($1) ON CONFLICT (slug) DO NOTHING RETURNING id',
      [slug],
    );
    return (rows[0] as { id: string } | undefined)?.id;
  });

  if (inserted !== undefined) return inserted;

  // Someone else inserted it. Re-read outside the transaction above rather than
  // inside it: that transaction's snapshot predates the concurrent commit, so a
  // second SELECT within it can legitimately see nothing. A fresh read cannot.
  const raced = await lookup(slug);
  if (raced !== undefined) return raced;

  throw new RepoIdentityError(`could not resolve repo ${JSON.stringify(slug)} to a repo_id`);
}
