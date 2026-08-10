# Benchmark results

Recorded 2026-08-10T16:08:34.192Z. Seed 1729, 5 agents,
30 tasks, 3 runs per arm. Median shown.

| metric                | naive | cortex |
|-----------------------|-------|--------|
| duplicate_work_rate   |  0.21 |   0.08 |
| lost_writes           |    21 |      0 |
| conflicting_edits     |     3 |      0 |
| wasted_tokens         |  4000 |   1975 |
| goodput (tasks/min)   | 38.16 | 180.23 |
| claim_p50 (ms)        |     — |    677 |
| claim_p95 (ms)        |     — |    808 |
| serialization_retries |     — |      0 |

## Spread across the three runs

| metric | arm | min | median | max |
|--------|-----|-----|--------|-----|
| duplicateWorkRate | naive | 0.21 | 0.21 | 0.21 |
| duplicateWorkRate | cortex | 0.08 | 0.08 | 0.08 |
| lostWrites | naive | 21 | 21 | 21 |
| lostWrites | cortex | 0 | 0 | 0 |
| conflictingEdits | naive | 3 | 3 | 3 |
| conflictingEdits | cortex | 0 | 0 | 0 |
| wastedTokens | naive | 4000 | 4000 | 4000 |
| wastedTokens | cortex | 1975 | 1975 | 1975 |
| goodputPerMinute | naive | 38.16 | 38.16 | 38.16 |
| goodputPerMinute | cortex | 180.23 | 180.23 | 180.23 |
| claimP50Ms | naive | — | — | — |
| claimP50Ms | cortex | 676 | 677 | 678 |
| claimP95Ms | naive | — | — | — |
| claimP95Ms | cortex | 803 | 808 | 813 |
| serializationRetries | naive | — | — | — |
| serializationRetries | cortex | 0 | 0 | 0 |

Most rows do not move at all, and that is the point rather than a coincidence:
the coordination outcomes are deterministic at a fixed seed against the committed
cassettes, so only the wall-clock rows vary. `test/bench-runner.test.ts` asserts
it by running each arm twice and comparing the decision sequences.

## What was held constant

Both arms ran the same 30 tasks, dealt to 5 agents in the same seeded order, on
the same simulated clock, drawing on the same recorded reasoning and the same
recorded embeddings. The only difference between them is where the shared state
lives. Model reasoning is replayed; **database behaviour is live in both arms** —
the NAIVE arm really does lose writes to its JSON file, and is not scripted to.

## Reproducing this

```
npm run bench:results
```

**Prerequisite: a CockroachDB cluster of your own**, named by `CORTEX_DSN`. The
CORTEX arm cannot run without one — that is the point of the harness, not a
restriction on it. No Bedrock credentials are needed: the run replays cassettes
and reports `liveCalls: {embed: 0, reason: 0}`.

**What needs no prerequisites at all:** everything except re-running. The
committed cassettes, this table, `environment.json`, the full run record in each
arm's JSON file, and the offline judge are all in the repository, so the
threshold sweep and every metric above can be recomputed from a clean clone with
nothing provisioned.

## Why the CORTEX arm is not at zero

`duplicate_work_rate` is 0.08 for CORTEX, not 0.00, and
the reason is the more useful half of the result.

The mechanism ships a dedupe threshold of **0.28**
(`src/memory/propose.ts`); the offline judge scores at
**0.4**, chosen from the sweep and not from the mechanism. At the
shipped value the sweep catches 4 of the
6 declared pairs; at the judge's value it catches all
6, with no false positives at either. So the
2 duplicates the judge found in the CORTEX arm are
exactly the pairs the mechanism let through.

**The threshold was not changed to make this number better.** Tuning the
mechanism against the benchmark that scores it is the circularity `06` §3 exists
to prevent, and `03` §4.2 marks the constant `[OPEN]` and empirical — moving it is
Julian's call, recorded in `docs/SPEC-DELTA.md`, not a side effect of publishing a
table.

## Metrics that moved the wrong way

None at this seed. That is a claim about one workload at one seed, not about
the mechanism; the limitations below are the honest reading of it.

## Limitations, stated by the author

- **Small synthetic corpus.** 40 fixture files, 30 tasks, one workload shape.
  Overlap was chosen so the failure modes appear at all (`06` §4); a repository
  with less overlap would show less difference, and that is a real caveat rather
  than a disclaimer.
- **Replayed reasoning.** The agents do not think during a run. Recorded once
  against Bedrock, replayed identically for both arms.
- **The harness serialises.** One step runs at a time so the run reproduces, so
  two transactions never overlap: `serialization_retries` is 0 by construction
  and the claim latencies are uncontended. The real race is evidenced separately
  by `npm run gate:contend` and by `test/retry.test.ts`.
- **CORTEX recall returns nothing.** `findings` is populated by consolidation,
  which is changefeed-driven and not built. The NAIVE arm meanwhile reads its own
  local note store and gets real hits, so on the three recall-dependent tasks
  this benchmark **understates** CORTEX.
- **Single region, single cluster tier.** See `environment.json`.
- **`goodput` is per simulated minute, not per wall-clock minute.** Wall clock
  would compare a local file write against a cloud round trip and call the
  difference a coordination result.
