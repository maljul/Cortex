/**
 * APPLYING AN AGENT'S WORK — the half of "an agent did something" that did not exist.
 *
 * Until 2026-08-13 an agent's output was `Effect { file, startLine, endLine }` — line numbers
 * and nothing else — and no code in this repository ever wrote a file. So the demo could
 * render verdicts (`granted` / `blocked` / `deduped`) and counters, and could not render a
 * *result*. "A write was lost" was a number rather than a missing function body.
 *
 * A patch here is an anchored replacement: exact `find` text, exact `replace` text. Not a
 * line range, and not a unified diff.
 *
 * - **Not a line range**, because line numbers shift under every other patch to the same
 *   file. Two agents editing one file would each be numbering a different version of it, and
 *   the second would land its change in the wrong place — which looks exactly like the
 *   coordination failure this demo exists to show, while actually being a bug in this module.
 * - **Not a unified diff**, because applying one needs context matching and fuzz, and a
 *   fuzzy apply that lands *somewhere* is precisely what must not happen on a page whose
 *   claim is that every result is real.
 *
 * **A missing anchor throws.** Editing a fixture without editing the patch that targets it is
 * a broken demo, and the only acceptable time to discover that is in the test suite.
 *
 * There is no SQL in this file and there must not be: `scripts/gate-mechanical.sh` keeps
 * statements inside `src/memory/` and `src/db/`. The patch *content* is fixture source that
 * happens to contain SQL, which is why the workload lives in `bench/demo-workload.ts`, beside
 * the fixtures it patches, rather than under `src/`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export interface Patch {
  /** Path relative to the fixture corpus root, e.g. `src/orders/repository.ts`. */
  file: string;
  /** Exact text to find. Must appear exactly once. */
  find: string;
  /** Exact text to put in its place. */
  replace: string;
}

/** File path to contents. The unit an agent reads and writes back. */
export type FileTree = Record<string, string>;

export class PatchError extends Error {}

/**
 * Resolved from this module rather than from `process.cwd()`.
 *
 * `npm test`, `npm run serve` and a deployed Lambda all run from different places, and a
 * corpus that moved with the working directory would make a patch apply in one and throw in
 * another. `bench/reason.ts` resolves its corpus the same way and for the same reason.
 */
function repoRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/**
 * The benchmark's corpus — the 40-file orders service `06` §4 describes. Frozen by `08` §4's
 * passed gate; nothing the demo does may change it.
 */
export const BENCH_CORPUS = 'bench/fixtures';

/**
 * The demo's own corpus — the small orders dashboard the agents build on screen, added
 * 2026-08-13 so a lost write is a missing *feature* rather than a missing hunk. Separate from
 * the benchmark's on purpose: see `bench/demo-app/README.md`.
 */
export const DEMO_APP_CORPUS = 'bench/demo-app';

/**
 * Reads committed files an agent is about to work on, keyed by their path within `root`.
 *
 * `root` is explicit rather than global because there are now two corpora and they must never
 * be confused: patching a benchmark fixture would invalidate `08` §4's committed results.
 */
export function loadFixtureTree(
  files: readonly string[],
  root: string = BENCH_CORPUS,
): FileTree {
  const tree: FileTree = {};
  for (const file of files) {
    tree[file] = readFileSync(join(repoRoot(), root, file), 'utf8');
  }
  return tree;
}

/**
 * Returns a **new** tree with `patch` applied.
 *
 * New rather than mutated, because the naive lane's whole mechanism is agents holding stale
 * copies: each one reads the shared tree, works on its own snapshot, and writes the snapshot
 * back over whatever landed meanwhile. Mutating a shared object would quietly make every
 * agent see every other agent's work and delete the thing being demonstrated.
 */
export function applyPatch(tree: FileTree, patch: Patch): FileTree {
  const before = tree[patch.file];
  if (before === undefined) {
    throw new PatchError(`${patch.file} is not in this tree, so nothing could be patched`);
  }

  const first = before.indexOf(patch.find);
  if (first === -1) {
    throw new PatchError(
      `anchor not found in ${patch.file}. Either the fixture changed without its patch, or ` +
        'this patch was already applied. Both are bugs and neither may be ignored.',
    );
  }

  // An anchor matching twice would make "which one did the agent mean?" a coin toss, and the
  // answer would differ between arms. Better to refuse and have the author narrow it.
  if (before.indexOf(patch.find, first + 1) !== -1) {
    throw new PatchError(
      `anchor appears more than once in ${patch.file}; narrow it so the target is unambiguous`,
    );
  }

  return { ...tree, [patch.file]: before.replace(patch.find, patch.replace) };
}
