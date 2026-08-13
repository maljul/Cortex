/**
 * THE ARGUMENT, EXECUTABLE — three compatible changes to one file, and what each stack does
 * to them.
 *
 * This is the demo's central claim reduced to something a test can decide. `07` §2 asks the
 * naive toggle to make the contrast visible rather than described, and until 2026-08-13 the
 * demo could only describe it: an agent's output was `Effect { file, startLine, endLine }` —
 * line numbers, no code — so there was no result to show and nothing to lose. Each demo task
 * now carries a committed patch (`bench/demo-workload.ts`), and "a write was lost" becomes a
 * missing function body rather than a counter.
 *
 * **The three patches do not overlap and do not conflict.** C1 rewrites `allOrders`, C2
 * rewrites `updateOrderStatus`, C3 adds a stock check inside `insertOrder`. Any merge tool
 * would take all three without complaint. That is deliberate and it is the whole point: what
 * destroys two of them is not a textual conflict, it is **last-write-wins on the whole file**
 * — every agent read before the others wrote, so the file that survives contains only the
 * change of whichever agent saved last. `06` §2 defines the naive arm's shared state exactly
 * this way, and `src/memory/shared-state.ts` already demonstrates the same mechanism against
 * a JSONB cell.
 *
 * A reader who thinks "just use a merge tool" is right about conflicts and wrong about this:
 * there is nothing here for a merge tool to resolve.
 *
 * **Write-back is per file, and that is a decision worth stating.** An agent saves the files
 * it edited, not the whole tree it happened to read. Two agents on different files therefore
 * both survive — a clean merge, exactly as worktree isolation would give — and only the shared
 * file loses. That is what design §8 describes ("its final tree is missing changes agents
 * reported as done — and the changes that do survive contradict each other as well") and it is
 * what makes four of the five interlocks cross-module compositions rather than absences. It is
 * also **stricter than a three-way merge would be** on the shared file, and the page must say
 * which it is claiming: `git merge` of three disjoint hunks in one file is clean, so interlock
 * 3 is a whole-file write-back result, while interlocks 1, 2, 4 and 5 survive any merge
 * strategy at all.
 */
import { describe, expect, it } from 'vitest';

import { CONTENDED_FILE, patchesFor } from '../bench/demo-workload.js';
import { APP_FILES } from '../src/demo/app-bundle.js';
import { applyPatch, DEMO_APP_CORPUS, loadFixtureTree, type FileTree } from '../src/demo/patches.js';

const CONTENDERS = ['C1', 'C2', 'C3'] as const;

/** What every agent in the naive lane reads before it starts. */
function baseline(): FileTree {
  return loadFixtureTree(APP_FILES, DEMO_APP_CORPUS);
}

/** The three features, as text that is either in the shared file or is not. */
const FEATURES = {
  pager: 'ORDERS_PER_PAGE',
  timeline: 'STATUS_HISTORY[id].push',
  oversell: 'insufficient stock',
} as const;

function survivingFeatures(tree: FileTree): string[] {
  const file = tree[CONTENDED_FILE] ?? '';
  return Object.entries(FEATURES)
    .filter(([, marker]) => file.includes(marker))
    .map(([name]) => name);
}

describe('the committed patches apply to the committed corpus', () => {
  it.each(
    // Every task with patches, both variants where there are two: an informed patch whose
    // anchor has drifted is a demo that breaks only in the lane the interlock lives in.
    ['P6a', 'P6b', 'P2a', 'P2b', 'C1', 'C2', 'C3', 'I3', 'R3'].flatMap((id) =>
      [false, true].map((informed) => ({ id, informed })),
    ),
  )('$id applies cleanly (informed: $informed)', ({ id, informed }) => {
    // A patch whose `find` text has drifted out of the corpus is a broken demo that would
    // only surface in front of a judge. `applyPatch` throws rather than no-oping, so editing
    // a file without editing its patch fails here.
    let tree = baseline();
    for (const patch of patchesFor(id, informed)) tree = applyPatch(tree, patch);
    expect(Object.keys(tree)).toHaveLength(APP_FILES.length);
  });

  it('refuses a patch whose anchor is no longer in the file', () => {
    expect(() =>
      applyPatch(baseline(), {
        file: CONTENDED_FILE,
        find: 'a line that is not in the corpus',
        replace: 'anything',
      }),
    ).toThrow(/not found/i);
  });

  it('refuses to apply the same patch twice', () => {
    // Applying a patch on top of itself means the anchor is gone, so the second attempt
    // throws rather than silently duplicating a change. That is what makes an idempotent
    // re-run visible instead of corrupting the tree.
    const patch = patchesFor('C1')[0]!;
    const once = applyPatch(baseline(), patch);
    expect(() => applyPatch(once, patch)).toThrow(/not found/i);
  });
});

describe('three agents, one file — what each stack does to it', () => {
  it('CORTEX keeps all three, because only one agent holds the file at a time', () => {
    // Arbitration serialises them: each agent takes the claim, reads the *current* tree,
    // applies, and releases. Nobody is working from a stale copy.
    let tree = baseline();
    for (const id of CONTENDERS) {
      for (const patch of patchesFor(id)) tree = applyPatch(tree, patch);
    }

    expect(survivingFeatures(tree).sort()).toEqual(['oversell', 'pager', 'timeline']);
  });

  it('the naive stack keeps exactly one — the other two are reported done and are gone', () => {
    // **The shared tree is read ONCE and every agent works from that same object**, which is
    // `06` §2's "last-write-wins" and is what `demo_shared_state` holds.
    //
    // The first version of this test called `baseline()` per agent, re-reading from disk three
    // times. It passed — and it passed for the wrong reason: mutating `applyPatch` to write
    // through to its input left every assertion green, because three independent reads cannot
    // share state to corrupt. Written this way that mutation fails it, which is the only
    // version worth having.
    const shared = baseline();

    const snapshots = CONTENDERS.map((id) => {
      let mine: FileTree = shared;
      for (const patch of patchesFor(id)) mine = applyPatch(mine, patch);
      return { id, mine, files: patchesFor(id).map((p) => p.file) };
    });

    // Each agent saves the files it edited, in the order the saves land.
    const saved: FileTree = { ...shared };
    for (const snapshot of snapshots) {
      for (const file of snapshot.files) saved[file] = snapshot.mine[file]!;
    }

    // The number that goes on screen, and the reason it is worth showing: all three agents
    // reported success and two of the three changes are not in the file.
    expect(survivingFeatures(saved)).toHaveLength(1);
  });

  it('the view half of each lost ticket survives, so the loss is legible rather than total', () => {
    // This is what a per-file write-back buys the page. C1's pager chrome is in
    // `orders/list.js`, which nobody else touches, so it lands — and calls an `allOrders`
    // that never learned to page. "The pager is there and does not page" is a defect a judge
    // reads off the screen; "the file is missing" is one they have to be told about.
    const shared = baseline();
    const c1 = patchesFor('C1').reduce((tree, patch) => applyPatch(tree, patch), shared as FileTree);
    const c3 = patchesFor('C3').reduce((tree, patch) => applyPatch(tree, patch), shared as FileTree);

    const saved: FileTree = { ...shared };
    for (const patch of patchesFor('C1')) saved[patch.file] = c1[patch.file]!;
    for (const patch of patchesFor('C3')) saved[patch.file] = c3[patch.file]!;

    expect(saved['orders/list.js']).toContain('class="pager"');
    expect(saved[CONTENDED_FILE]).not.toContain('ORDERS_PER_PAGE');
    expect(survivingFeatures(saved)).toEqual(['oversell']);
  });

  it('the three patches genuinely do not conflict, so a merge tool is not the answer', () => {
    // Each rewrites a different region of the shared file. If this ever fails, the demo is
    // showing a merge conflict rather than a coordination failure, and the argument changes
    // completely.
    const base = baseline()[CONTENDED_FILE]!;
    const regions = CONTENDERS.flatMap((id) =>
      patchesFor(id)
        .filter((p) => p.file === CONTENDED_FILE)
        .map((p) => p.find),
    );

    expect(regions).toHaveLength(3);
    for (const region of regions) {
      expect(base).toContain(region);
    }
    for (const [i, a] of regions.entries()) {
      for (const b of regions.slice(i + 1)) {
        expect(a.includes(b) || b.includes(a)).toBe(false);
      }
    }
  });
});
