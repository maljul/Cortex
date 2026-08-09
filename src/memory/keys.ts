/**
 * Resource key grammar, per spec/03-MEMORY-MODEL.md §3.
 *
 * Two agents describing the same target must produce the same string, because the
 * uniqueness of that string in `claims` IS the mutual exclusion. A key that
 * normalises inconsistently is a silent double-grant.
 */

/** spec §3: refusing is safer than claiming at directory granularity, and is the default. */
export const MAX_EXPANDED_KEYS = 200;

export type Scheme = 'file' | 'glob' | 'migration' | 'service';

const SCHEMES: readonly Scheme[] = ['file', 'glob', 'migration', 'service'];

export class ResourceKeyError extends Error {}

/**
 * Canonicalises a resource key. POSIX separators, no leading `./`, lowercase scheme.
 *
 * The path body keeps its case: `file:src/Auth.ts` and `file:src/auth.ts` are
 * different files on a case-sensitive checkout, and collapsing them would let two
 * agents edit the same file believing they hold different keys.
 */
export function canonicalKey(raw: string): string {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf(':');

  if (separator === -1) {
    throw new ResourceKeyError(`resource key has no scheme: ${JSON.stringify(raw)}`);
  }

  const scheme = trimmed.slice(0, separator).toLowerCase();
  if (!SCHEMES.includes(scheme as Scheme)) {
    throw new ResourceKeyError(`unknown resource key scheme: ${JSON.stringify(scheme)}`);
  }

  let body = trimmed.slice(separator + 1);

  if (scheme === 'file' || scheme === 'glob') {
    body = body.replace(/\\/g, '/');
    while (body.startsWith('./')) body = body.slice(2);
    body = body.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    if (body.startsWith('/')) {
      throw new ResourceKeyError(`${scheme} keys are repo-relative, got absolute: ${body}`);
    }
    if (body.split('/').includes('..')) {
      throw new ResourceKeyError(`${scheme} key escapes the repo: ${body}`);
    }
  }

  if (body === '') {
    throw new ResourceKeyError(`resource key has an empty body: ${JSON.stringify(raw)}`);
  }

  return `${scheme}:${body}`;
}

export function schemeOf(key: string): Scheme {
  return key.slice(0, key.indexOf(':')) as Scheme;
}

/**
 * Resolves a glob to the concrete files it currently matches. Injected rather than
 * imported so tests can pin a file set, and so the CLI can supply a real one.
 */
export interface GlobResolver {
  (pattern: string): Promise<string[]> | string[];
}

/**
 * Expands the requested keys into the full set that must be claimed.
 *
 * spec §3: a `glob:` claim conflicts with any `file:` claim it matches, and the
 * reverse. `ON CONFLICT` cannot express that, so the overlap is made structural —
 * a glob is claimed as one row per matched file *plus* a row for the glob itself.
 * A later `file:` claim then collides on the concrete row, and a later identical
 * `glob:` claim collides on the glob row.
 *
 * The returned array is deduplicated and sorted. Sorting matters: two transactions
 * inserting the same keys in different orders can deadlock, and a stable order
 * makes the contested set reproducible in tests.
 */
export async function expandKeys(
  requested: readonly string[],
  resolveGlob: GlobResolver,
): Promise<string[]> {
  if (requested.length === 0) {
    throw new ResourceKeyError('a claim must name at least one resource key');
  }

  const expanded = new Set<string>();

  for (const raw of requested) {
    const key = canonicalKey(raw);
    expanded.add(key);

    if (schemeOf(key) === 'glob') {
      const pattern = key.slice('glob:'.length);
      for (const match of await resolveGlob(pattern)) {
        expanded.add(canonicalKey(`file:${match}`));
      }
    }
  }

  if (expanded.size > MAX_EXPANDED_KEYS) {
    throw new ResourceKeyError(
      `claim expands to ${expanded.size} keys, over the ${MAX_EXPANDED_KEYS} limit. ` +
        'Narrow the glob; spec/03-MEMORY-MODEL.md §3 refuses rather than claiming a directory.',
    );
  }

  return [...expanded].sort();
}
