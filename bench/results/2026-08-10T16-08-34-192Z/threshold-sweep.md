# Dedupe threshold sweep

Recorded 2026-08-10T16:08:34.192Z. Distance is cosine over the committed embedding
cassettes, computed in `bench/judge.ts` — not by the operator the mechanism
uses. Ground truth is the `pair` label in `bench/tasks.json`, written by hand
before anything was measured.

| threshold | pairs caught | of them declared | false positives | precision | recall |
|-----------|--------------|------------------|-----------------|-----------|--------|
|      0.20 |            2 |                2 |               0 |     1.000 |  0.333 |
|      0.24 |            4 |                4 |               0 |     1.000 |  0.667 |
|      0.28 |            4 |                4 |               0 |     1.000 |  0.667 |
|      0.32 |            4 |                4 |               0 |     1.000 |  0.667 |
|      0.34 |            5 |                5 |               0 |     1.000 |  0.833 |
|      0.36 |            5 |                5 |               0 |     1.000 |  0.833 |
|      0.38 |            6 |                6 |               0 |     1.000 |  1.000 |
|      0.40 |            6 |                6 |               0 |     1.000 |  1.000 |
|      0.42 |            6 |                6 |               0 |     1.000 |  1.000 |
|      0.44 |            8 |                6 |               2 |     0.750 |  1.000 |
|      0.48 |            8 |                6 |               2 |     0.750 |  1.000 |
|      0.55 |            9 |                6 |               3 |     0.667 |  1.000 |

## Reading it

**Precision is the expensive column.** A false positive means the CORTEX arm
skipped work that genuinely needed doing and booked the skip as a saving, so a
threshold bought at the cost of precision improves the headline number and
degrades the system.

The judge scores at **0.4**, chosen from this table rather than
from the mechanism: it is inside the band where recall is 1.000 and precision is
still 1.000. `src/memory/propose.ts` ships a different value, and that gap is
recorded in `docs/SPEC-DELTA.md` against `03` §4.2, which marks the threshold
`[OPEN]` and empirical. Nothing here changes the mechanism's constant.
