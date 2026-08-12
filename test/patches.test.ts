/**
 * THE ARGUMENT, EXECUTABLE — three compatible changes to one file, and what each stack does
 * to them.
 *
 * This is the demo's central claim reduced to something a test can decide. `07` §2 asks the
 * naive toggle to make the contrast visible rather than described, and until now the demo
 * could only describe it: an agent's output was `Effect { file, startLine, endLine }` — line
 * numbers, no code — so there was no result to show and nothing to lose. Each demo task now
 * carries a committed patch (`bench/demo-workload.ts`), and "a write was lost" becomes a
 * missing function body rather than a counter.
 *
 * **The three patches do not overlap and do not conflict.** C1 rewrites `allOrders`, C2
 * rewrites `updateOrderStatus`, C3 adds a stock check inside `insertOrder`. Any merge tool
 * would take all three without complaint. That is deliberate and it is the whole point: what
 * destroys two of them is not a textual conflict, it is **last-write-wins on the whole file**
 * — every agent read before the others wrote, so every agent writes back a tree containing
 * only its own change. `06` §2 defines the naive arm exactly this way, and
 * `src/memory/shared-state.ts` already demonstrates the same mechanism against a JSONB cell.
 *
 * A reader who thinks "just use a merge tool" is right about conflicts and wrong about this:
 * there is nothing here for a merge tool to resolve.
 */
import { describe, expect, it } from 'vitest';

import { CONTENDED_FILE, DEMO_TASKS, patchesFor } from '../bench/demo-workload.js';
import { applyPatch, loadFixtureTree, type FileTree } from '../src/demo/patches.js';

const FILES = [CONTENDED_FILE];

/** What every agent in the naive lane reads before it starts. */
function baseline(): FileTree {
  return loadFixtureTree(FILES);
}

describe('the committed patches apply to the committed fixtures', () => {
  it.each(DEMO_TASKS.filter((t) => t.patches.length > 0).map((t) => t.id))(
    '%s applies cleanly',
    (id) => {
      const task = DEMO_TASKS.find((t) => t.id === id)!;
      // A patch whose `find` text has drifted out of the fixture is a broken demo that
      // would only surface in front of a judge. `applyPatch` throws rather than no-oping,
      // so editing a fixture without editing its patch fails here.
      let tree = loadFixtureTree(task.patches.map((p) => p.file));
      for (const patch of task.patches) tree = applyPatch(tree, patch);
      expect(Object.keys(tree).length).toBeGreaterThan(0);
    },
  );

  it('refuses a patch whose anchor is no longer in the file', () => {
    expect(() =>
      applyPatch(baseline(), {
        file: CONTENDED_FILE,
        find: 'a line that is not in the fixture',
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
  const contenders = ['C1', 'C2', 'C3'] as const;

  it('CORTEX keeps all three, because only one agent holds the file at a time', () => {
    // Arbitration serialises them: each agent takes the claim, reads the *current* tree,
    // applies, and releases. Nobody is working from a stale copy.
    let tree = baseline();
    for (const id of contenders) {
      for (const patch of patchesFor(id)) tree = applyPatch(tree, patch);
    }

    const final = tree[CONTENDED_FILE]!;
    expect(final).toContain('LIMIT $1 OFFSET $2');
    expect(final).toContain('order_status_history');
    expect(final).toContain('insufficient stock');
  });

  it('the naive stack keeps exactly one — the other two are reported done and are gone', () => {
    // **The shared cell is loaded ONCE and every agent reads that same object**, which is
    // `06` §2's "JSON file on disk, last-write-wins" and is what `demo_shared_state` holds.
    //
    // The first version of this test called `baseline()` per agent, re-reading from disk
    // three times. It passed — and it passed for the wrong reason: mutating `applyPatch` to
    // write through to its input left all eight assertions green, because three independent
    // reads cannot share state to corrupt. Written this way the mutation fails it, which is
    // the only version of this test worth having.
    const shared = baseline();

    const snapshots = contenders.map((id) => {
      let mine = shared;
      for (const patch of patchesFor(id)) mine = applyPatch(mine, patch);
      return mine;
    });

    // The saves land in order; the last one to write is the tree that survives.
    let saved = shared;
    for (const snapshot of snapshots) saved = snapshot;

    const final = saved[CONTENDED_FILE]!;
    const survived = [
      final.includes('LIMIT $1 OFFSET $2'),
      final.includes('order_status_history'),
      final.includes('insufficient stock'),
    ].filter(Boolean);

    // The number that goes on screen, and the reason it is worth showing: all three agents
    // reported success and two of the three changes are not in the file.
    expect(survived).toHaveLength(1);
  });

  it('the three patches genuinely do not conflict, so a merge tool is not the answer', () => {
    // Each rewrites a different region. If this ever fails, the demo is showing a merge
    // conflict rather than a coordination failure, and the argument changes completely.
    const base = baseline()[CONTENDED_FILE]!;
    const regions = contenders.flatMap((id) => patchesFor(id).map((p) => p.find));

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
