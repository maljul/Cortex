# Recall threshold sweep

Recorded 2026-08-12T18:38:04.282Z. Distance is cosine computed by **CockroachDB's own `<=>`**
on live Titan Text Embeddings V2 vectors, 1024 dimensions — the operator and the model the
mechanism actually uses, not a reimplementation. Ground truth is `bench/recall-truth.json`,
written by hand before anything here was measured.

8 queries × 22 findings = 176 decided cells, 17 of them declared relevant.

| threshold | findings returned | of them relevant | false positives | precision | recall | queries served |
|-----------|-------------------|------------------|-----------------|-----------|--------|----------------|
|      0.20 |                 0 |                0 |               0 |     1.000 |  0.000 |            0/8 |
|      0.28 |                 0 |                0 |               0 |     1.000 |  0.000 |            0/8 |
|      0.32 |                 1 |                1 |               0 |     1.000 |  0.059 |            1/8 |
|      0.35 |                 1 |                1 |               0 |     1.000 |  0.059 |            1/8 |
|      0.38 |                 2 |                2 |               0 |     1.000 |  0.118 |            2/8 |
|      0.39 |                 4 |                4 |               0 |     1.000 |  0.235 |            3/8 |
|      0.40 |                 4 |                4 |               0 |     1.000 |  0.235 |            3/8 |
|      0.42 |                 5 |                5 |               0 |     1.000 |  0.294 |            3/8 |
|      0.45 |                 5 |                5 |               0 |     1.000 |  0.294 |            3/8 |
|      0.48 |                 7 |                7 |               0 |     1.000 |  0.412 |            5/8 |
|      0.50 |                 7 |                7 |               0 |     1.000 |  0.412 |            5/8 |
|      0.55 |                 8 |                8 |               0 |     1.000 |  0.471 |            5/8 |
|      0.60 |                 9 |                9 |               0 |     1.000 |  0.529 |            6/8 |
|      0.63 |                13 |               12 |               1 |     0.923 |  0.706 |            7/8 |
|      0.65 |                13 |               12 |               1 |     0.923 |  0.706 |            7/8 |
|      0.70 |                16 |               14 |               2 |     0.875 |  0.824 |            7/8 |
|      0.75 |                20 |               15 |               5 |     0.750 |  0.882 |            8/8 |
|      0.80 |                30 |               15 |              15 |     0.500 |  0.882 |            8/8 |
|      0.85 |                44 |               16 |              28 |     0.364 |  0.941 |            8/8 |
|      0.90 |                80 |               17 |              63 |     0.212 |  1.000 |            8/8 |

## Where the relevant findings actually sit

| query | nearest relevant finding | dist | nearest *irrelevant* finding | dist |
|-------|--------------------------|------|------------------------------|------|
| Q1 | FC4a | 0.4632 | FC2a | 0.7674 |
| Q2 | FP3b | 0.4601 | FOC1 | 0.8248 |
| Q3 | FI3a | 0.5736 | FSQ1 | 0.7011 |
| Q4 | FOC1 | 0.3801 | FP6a | 0.6253 |
| Q5 | FP1b | 0.3711 | FI6a | 0.7275 |
| Q6 | FI8a | 0.7364 | FP5a | 0.7940 |
| Q7 | FP2a | 0.2981 | FP5a | 0.7468 |
| Q8 | FP6a | 0.6262 | FOC3 | 0.8388 |

## The twelve closest declared-irrelevant pairs

What any distance filter has to survive. If these sit far out, the filter is not what is
keeping noise out of an agent's context — the `LIMIT k` and the ordering are.

| query | finding | dist |
|-------|---------|------|
| Q4 | FP6a | 0.6253 |
| Q4 | FI4a | 0.6825 |
| Q3 | FSQ1 | 0.7011 |
| Q5 | FI6a | 0.7275 |
| Q7 | FP5a | 0.7468 |
| Q5 | FP5a | 0.7646 |
| Q1 | FC2a | 0.7674 |
| Q4 | FP3b | 0.7738 |
| Q7 | FI8a | 0.7849 |
| Q4 | FC4a | 0.7909 |
| Q4 | FC4b | 0.7912 |
| Q5 | FOC1 | 0.7927 |

## Reading it

**`queries served` is the column that matters for `07` §3 beat 1.** It counts queries that get
at least one genuinely relevant finding back. A threshold can hold precision at 1.000 and still
answer "nothing known" to every question the fleet can actually help with.

**At 0.35, 1 of 8 queries is served** and recall is 0.059.
That is a sharper statement of the problem than V28 had: V28 showed one query returning nothing,
and the reading available at the time was that its wordings were unlucky. Across eight queries the
filter excludes almost everything that bears on the work.

**0.60 is the largest threshold on this corpus with zero false positives**, and it serves 6 of 8. The
first false positive appears at 0.63, and precision then falls away quickly rather than gently.
So the choice is not "tight and safe versus loose and noisy" — everything from 0.35 up to
0.60 is free.

### What was chosen

**`src/memory/recall.ts` ships 0.60, changed from 0.35 on 2026-08-12, and that is disclosed here
rather than left for a reader to notice.** Julian chose it from this table, as `03` §4.2's dedupe
threshold was chosen from its own.

It is the top of the free range, not the bottom: 6/8 served at precision 1.000. Choosing the
*smallest* value that made the demo's beat 1 fire would have been 0.39 — which is also the dedupe
constant, and picking the minimum that rescues the demo is the shape of the thing `06` §3 forbids.
The criterion used instead — largest threshold returning nothing irrelevant — is a property of the
corpus and would have selected the same number with no demo in existence.

**Precision is still the expensive column**, for the reason the dedupe sweep gives: a false
positive here puts a finding in an agent's context that does not bear on its work, and the
agent pays attention to it.

**There is no threshold at which precision and recall are both 1.000**, unlike the dedupe sweep,
which had a clean band. That difference is not noise, and the next section is why.

### Ranking is perfect here; thresholding is not

In **8 of 8** queries, the nearest relevant finding is closer than the nearest irrelevant
one. Sorting by distance puts the right finding first every time. But the distance at which the
right finding sits ranges from **0.2981 to 0.7364** across these queries — a spread of 0.44 —
and no single constant can sit above all eight and below the noise for all eight at once.

That points somewhere specific. `RECALL_SQL` already orders by `times_reverted DESC, n.dist ASC`
and already caps the result at `LIMIT $5` (`DEFAULT_K` = 8). On this corpus the ordering and the
cap are doing the work, and `dist < $4` is a blunt second guard that is currently set tight enough
to discard the answer before the ordering ever sees it. Whoever closes this should consider
whether the constant wants to be a *backstop* — loose enough to be inert in the normal case — rather
than the primary filter it is today.

**The counter-argument, stated fairly:** this corpus holds 22 findings. A real repository holds
thousands, and the density just under any threshold grows with it. The `LIMIT k` bounds how many
rows an agent sees but not how *bad* the eighth one is, and that is exactly what the distance
filter is for. This sweep bounds the threshold from below; it does not prove a ceiling.

### Sensitivity to the arguable calls

9 of the 176 cells are marked `arguable` in the ground truth. Flipping **every**
one of them gives:

| threshold | findings returned | of them relevant | false positives | precision | recall | queries served |
|-----------|-------------------|------------------|-----------------|-----------|--------|----------------|
|      0.20 |                 0 |                0 |               0 |     1.000 |  0.000 |            0/8 |
|      0.28 |                 0 |                0 |               0 |     1.000 |  0.000 |            0/8 |
|      0.32 |                 1 |                1 |               0 |     1.000 |  0.050 |            1/8 |
|      0.35 |                 1 |                1 |               0 |     1.000 |  0.050 |            1/8 |
|      0.38 |                 2 |                2 |               0 |     1.000 |  0.100 |            2/8 |
|      0.39 |                 4 |                4 |               0 |     1.000 |  0.200 |            3/8 |
|      0.40 |                 4 |                4 |               0 |     1.000 |  0.200 |            3/8 |
|      0.42 |                 5 |                5 |               0 |     1.000 |  0.250 |            3/8 |
|      0.45 |                 5 |                5 |               0 |     1.000 |  0.250 |            3/8 |
|      0.48 |                 7 |                7 |               0 |     1.000 |  0.350 |            5/8 |
|      0.50 |                 7 |                7 |               0 |     1.000 |  0.350 |            5/8 |
|      0.55 |                 8 |                8 |               0 |     1.000 |  0.400 |            5/8 |
|      0.60 |                 9 |                9 |               0 |     1.000 |  0.450 |            6/8 |
|      0.63 |                13 |               12 |               1 |     0.923 |  0.600 |            7/8 |
|      0.65 |                13 |               12 |               1 |     0.923 |  0.600 |            7/8 |
|      0.70 |                16 |               14 |               2 |     0.875 |  0.700 |            7/8 |
|      0.75 |                20 |               16 |               4 |     0.800 |  0.800 |            8/8 |
|      0.80 |                30 |               18 |              12 |     0.600 |  0.900 |            8/8 |
|      0.85 |                44 |               19 |              25 |     0.432 |  0.950 |            8/8 |
|      0.90 |                80 |               19 |              61 |     0.237 |  0.950 |            8/8 |

Still no perfect band under the flipped calls.

## The ordering question

SPEC-DELTA asked whoever ran this to say why recall and dedupe sit where they do relative to
each other. `src/memory/propose.ts` dedupes at **0.39**. §4.1 publishes **0.35** — *tighter*.

That ordering is wrong on the meaning of the two tests, independently of anything in this table.
Dedupe asks "is this the same work", and answering yes **cancels an agent's task** — a false
positive destroys work that needed doing. Recall asks "might this bear on what I am about to do",
and answering yes **adds a line to a context window** — a false positive costs attention. The
strict test is the one with the expensive error, so dedupe must be the tighter of the two, and
recall must be the looser. Today it is the other way round.

This argument does not depend on the demo, and it was written down in `docs/SPEC-DELTA.md` on
2026-08-11 — before the demo's beat 1 was known to be affected by it. That is what keeps moving
the constant out of `06` §3's circularity: the ordering was wrong on its own terms first.

## Limitations, and one that weakens the result

**The hard negatives are not as hard as they were designed to be.** `bench/recall-truth.json`
deliberately included findings that share vocabulary with a query without bearing on it — FI4a,
SMS delivery-failure retries, was written as the trap for Q4 "add a retry to the orders client".
Titan does not place it anywhere near: it sits at 0.6825, further out than FP6a at 0.6253,
which was not designed as a trap at all. Shared vocabulary turns out to be a poor way to
manufacture a near-miss under this model. The practical consequence is that **the precision
column here is optimistic** — a corpus with genuinely adversarial negatives would break precision
earlier than 0.63, and nobody should read 1.000 as a promise.

**Eight queries and 22 findings is a small corpus.** The dedupe sweep it is modelled on scored 6
declared pairs, so this is the same order of evidence, but neither is large. Both are bounded by
what one person can label honestly by hand.

## What this sweep does not do

It does not pick the number. `03` §4.2's dedupe threshold was closed by Julian as a separate act
with the measurement in front of him, and the same applies here. It also does not touch
`JUDGE_THRESHOLD` or the dedupe constant: whatever recall becomes, it is a third independent
number, and three constants drawn from one band would read as one constant with three names.
