/**
 * `06` §3'S `conflicting_edits`, AND THE FIGURE IT DOES NOT CATCH.
 *
 * §3 defines `conflicting_edits` as file regions written by two or more agents in overlapping
 * time windows, and `bench/metrics.ts` has computed it for the benchmark since U13. The demo has
 * never been able to: until U21 an agent's output was `{ file, startLine, endLine }` with no code
 * behind it, and nothing wrote a file. Real patches gave it real line ranges.
 *
 * **Measured before this module was written (V51), and the measurement is why there are two
 * functions here rather than one.** All thirteen of the cut's patch hunks anchor against the
 * committed corpus, so line ranges are derivable rather than invented — but under §3's rule the
 * run scores **1**, and that one is the dedupe pair doing identical work at identical lines.
 * **Interlock 3 — three features in one file, the naive lane's most visible failure — scores 0**,
 * because C1, C2 and C3 edit disjoint regions of `orders/repository.js`.
 *
 * The naive lane loses two of those three anyway. It loses them to `demo_shared_state`'s
 * per-file write-back: an agent saves the files it edited, so a second agent that read the file
 * before the first saved overwrites it wholesale. That is **file-granular**, where §3's metric is
 * **line-granular**. Both are correct and they measure different things, which is why Julian's
 * call on 2026-08-13 was to publish both under separate names rather than bend either.
 */
import { describe, expect, it } from 'vitest';

import { conflictingEdits, fileCollisions, type WorkSpan } from '../src/demo/conflicts.js';

function span(over: Partial<WorkSpan> & { agent: string; startLine: number; endLine: number }): WorkSpan {
  return {
    taskId: 'T',
    file: 'orders/repository.js',
    startedMs: 0,
    endedMs: 100,
    ...over,
  };
}

describe('conflicting_edits — `06` §3, line-granular', () => {
  it('counts two agents overlapping in both lines and time', () => {
    expect(
      conflictingEdits([
        span({ agent: 'agent-1', startLine: 10, endLine: 20 }),
        span({ agent: 'agent-2', startLine: 15, endLine: 25 }),
      ]),
    ).toBe(1);
  });

  it('does not count disjoint line ranges in the same file — interlock 3', () => {
    // The measured case: three features, one file, three agents, no overlap at all.
    expect(
      conflictingEdits([
        span({ taskId: 'C1', agent: 'agent-1', startLine: 10, endLine: 12 }),
        span({ taskId: 'C2', agent: 'agent-2', startLine: 30, endLine: 33 }),
        span({ taskId: 'C3', agent: 'agent-3', startLine: 50, endLine: 55 }),
      ]),
    ).toBe(0);
  });

  it('does not count one agent against itself', () => {
    expect(
      conflictingEdits([
        span({ agent: 'agent-1', startLine: 10, endLine: 20 }),
        span({ agent: 'agent-1', startLine: 15, endLine: 25 }),
      ]),
    ).toBe(0);
  });

  it('does not count work that never overlapped in time', () => {
    expect(
      conflictingEdits([
        span({ agent: 'agent-1', startLine: 10, endLine: 20, startedMs: 0, endedMs: 100 }),
        span({ agent: 'agent-2', startLine: 10, endLine: 20, startedMs: 200, endedMs: 300 }),
      ]),
    ).toBe(1 - 1);
  });

  it('does not count different files', () => {
    expect(
      conflictingEdits([
        span({ agent: 'agent-1', file: 'a.js', startLine: 10, endLine: 20 }),
        span({ agent: 'agent-2', file: 'b.js', startLine: 10, endLine: 20 }),
      ]),
    ).toBe(0);
  });

  /**
   * `bench/metrics.ts` counts **pairs of effects**, not pairs of agents, and this matches it
   * deliberately: the demo's number and the published benchmark's number must mean the same
   * thing or they cannot be shown on the same page.
   */
  it('counts effect pairs, the way the benchmark does', () => {
    // Both of agent-1's hunks have to overlap agent-2's for this to distinguish effect-pair
    // counting from agent-pair counting. The first version of this test used a second hunk at
    // 12–14, which does not reach 15–25 at all, and so asserted a coincidence.
    expect(
      conflictingEdits([
        span({ agent: 'agent-1', startLine: 10, endLine: 20 }),
        span({ agent: 'agent-1', startLine: 18, endLine: 22 }),
        span({ agent: 'agent-2', startLine: 15, endLine: 25 }),
      ]),
    ).toBe(2);
    // The same work, counted the other way, is one collision.
    expect(
      fileCollisions([
        span({ agent: 'agent-1', startLine: 10, endLine: 20 }),
        span({ agent: 'agent-1', startLine: 18, endLine: 22 }),
        span({ agent: 'agent-2', startLine: 15, endLine: 25 }),
      ]),
    ).toBe(1);
  });
});

describe('file collisions — what this lane actually loses to', () => {
  it('counts two agents on one file even when their lines are disjoint', () => {
    expect(
      fileCollisions([
        span({ taskId: 'C1', agent: 'agent-1', startLine: 10, endLine: 12 }),
        span({ taskId: 'C2', agent: 'agent-2', startLine: 30, endLine: 33 }),
      ]),
    ).toBe(1);
  });

  /**
   * Agent pairs per file, not hunk pairs — and that is the difference from `conflicting_edits`
   * above, which counts effects to stay comparable with the benchmark. A lost write costs one
   * file once however many hunks were in it, so counting hunks would inflate the figure against
   * the arm it describes.
   */
  it('counts an agent pair once however many hunks each wrote', () => {
    expect(
      fileCollisions([
        span({ agent: 'agent-1', startLine: 10, endLine: 12 }),
        span({ agent: 'agent-1', startLine: 40, endLine: 42 }),
        span({ agent: 'agent-2', startLine: 30, endLine: 33 }),
        span({ agent: 'agent-2', startLine: 60, endLine: 63 }),
      ]),
    ).toBe(1);
  });

  it('counts three agents on one file as three pairs', () => {
    expect(
      fileCollisions([
        span({ taskId: 'C1', agent: 'agent-1', startLine: 10, endLine: 12 }),
        span({ taskId: 'C2', agent: 'agent-2', startLine: 30, endLine: 33 }),
        span({ taskId: 'C3', agent: 'agent-3', startLine: 50, endLine: 55 }),
      ]),
    ).toBe(3);
  });

  it('still requires the windows to overlap', () => {
    expect(
      fileCollisions([
        span({ agent: 'agent-1', startLine: 10, endLine: 12, startedMs: 0, endedMs: 100 }),
        span({ agent: 'agent-2', startLine: 30, endLine: 33, startedMs: 200, endedMs: 300 }),
      ]),
    ).toBe(0);
  });

  /**
   * The relationship that makes publishing both honest: every line overlap is also a file
   * collision, so the pair can never be read as contradicting each other. Asserted on the shape
   * the real run produces rather than in the abstract.
   */
  it('is never smaller than the line-granular figure on the same work', () => {
    const spans = [
      span({ taskId: 'C1', agent: 'agent-1', startLine: 10, endLine: 12 }),
      span({ taskId: 'C2', agent: 'agent-2', startLine: 30, endLine: 33 }),
      span({ taskId: 'P2a', agent: 'agent-4', file: 'inventory/repository.js', startLine: 14, endLine: 16 }),
      span({ taskId: 'P2b', agent: 'agent-5', file: 'inventory/repository.js', startLine: 14, endLine: 16 }),
    ];

    expect(conflictingEdits(spans)).toBe(1);
    expect(fileCollisions(spans)).toBe(2);
    expect(fileCollisions(spans)).toBeGreaterThanOrEqual(conflictingEdits(spans));
  });
});
