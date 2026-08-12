# Benchmark results

Recorded 2026-08-12T18:35:38.014Z. Seed 1729, 5 agents,
30 tasks, 3 runs per arm. Median shown.

| metric                | naive | cortex |
|-----------------------|-------|--------|
| duplicate_work_rate   |  0.21 |   0.00 |
| lost_writes           |    21 |      0 |
| conflicting_edits     |     3 |      0 |
| wasted_tokens         |  4000 |    867 |
| goodput (tasks/min)   | 38.16 | 200.73 |
| claim_p50 (ms)        |     — |    732 |
| claim_p95 (ms)        |     — |    818 |
| serialization_retries |     — |      0 |

## Spread across the three runs

| metric | arm | min | median | max |
|--------|-----|-----|--------|-----|
| duplicateWorkRate | naive | 0.21 | 0.21 | 0.21 |
| duplicateWorkRate | cortex | 0.00 | 0.00 | 0.00 |
| lostWrites | naive | 21 | 21 | 21 |
| lostWrites | cortex | 0 | 0 | 0 |
| conflictingEdits | naive | 3 | 3 | 3 |
| conflictingEdits | cortex | 0 | 0 | 0 |
| wastedTokens | naive | 4000 | 4000 | 4000 |
| wastedTokens | cortex | 867 | 867 | 867 |
| goodputPerMinute | naive | 38.16 | 38.16 | 38.16 |
| goodputPerMinute | cortex | 200.73 | 200.73 | 200.73 |
| claimP50Ms | naive | — | — | — |
| claimP50Ms | cortex | 732 | 732 | 732 |
| claimP95Ms | naive | — | — | — |
| claimP95Ms | cortex | 807 | 818 | 875 |
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
**dedupe** threshold sweep (`threshold-sweep.md`) and every metric above can be
recomputed from a clean clone with nothing provisioned.

**`recall-threshold-sweep.md` in this directory is the exception and does not have
that property.** It is not produced by this script — `npm run sweep:recall` writes
it, making live Titan calls and computing its distances with the cluster's own
`<=>`. There are no cassettes behind it. Its ground truth (`bench/recall-truth.json`)
and its published table are committed and readable from a clean clone; reproducing
the numbers needs Bedrock and a cluster.

## The CORTEX arm is at zero, and how its threshold was chosen

`duplicate_work_rate` is 0.00 for CORTEX: the judge
finds no duplicated work in the arm's final state. The threshold that produces
that is the one number this benchmark recommended changing, so how it was
picked matters more than the row itself.

`src/memory/propose.ts` ships **0.39**, and the offline
judge scores at **0.4**. Both are drawn from
`threshold-sweep.md` and both sit inside the band where recall and precision
are 1.000 on this corpus — but they are **different numbers on purpose**. The
judge scores the benchmark that justifies the mechanism's value; carrying one
shared constant would read as the two having been tuned together.

**The threshold was changed, after this benchmark recommended it, and that is
disclosed rather than hidden.** It shipped at 0.28 through the
end-of-day-two gate, where it caught 4 of the
6 declared pairs and
0.39 catches all 6
— the published row was 0.21 → 0.08 rather than 0.21 → 0.00, and
the sweep said why. `03` §4.2 marked the constant `[OPEN]` and empirical, and
closing it was Julian's call with the sweep in front of him. Recorded in
`docs/DECISIONS.md`.

What `06` §3 forbids is the benchmark quietly tuning the mechanism it scores.
What defeats that is not abstaining from ever acting on a measurement — it is
publishing the sweep, the prior value, the value now, and the fact that one
followed the other. All four are in this directory.

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
- **CORTEX recall returns nothing, and the cause is the harness rather than the
  mechanism.** `findings` is populated by consolidation (`03` §4.4), which is
  changefeed-driven; this harness runs no changefeed, so the table stays empty for
  the whole run and every recall returns 0 rows. The NAIVE arm meanwhile reads its
  own local note store and gets real hits, so on the three recall-dependent tasks
  this benchmark **understates** CORTEX.
  *Two things this is not, both checked on 2026-08-12.* It is not "consolidation is
  unbuilt" — V27 built it, and `npm run gate:consolidate` proves it end to end; it
  is simply not wired into this offline harness. And it is not `03` §4.1's distance
  threshold: that constant moved 0.35 → 0.60 that day (V34) and **not one metric in
  the table above changed**, because an empty table returns nothing at any distance.
  The threshold was the binding constraint on the *demo*, which seeds a finding; it
  was never the binding constraint here.
- **Single region, single cluster tier.** See `environment.json`.
- **`goodput` is per simulated minute, not per wall-clock minute.** Wall clock
  would compare a local file write against a cloud round trip and call the
  difference a coordination result.
