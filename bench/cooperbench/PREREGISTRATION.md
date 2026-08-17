# Experiment 1 — external hard-negative dedupe audit

**Pre-registered 2026-08-17. Nothing in this file has been measured.** The manifest beside it
(`manifest.json`, 199 features and 652 pairs, sha256
`d3de988e8b3cff6be2f864888c026bd81b575b0e3c4e1a7cf0ebeecf50a9b41e`) was built and committed in
the same act. If a result ever appears that this document did not predict the shape of, the
commit history is what shows which came first.

---

## 1. Why this exists

CORTEX's published benchmark reports `duplicate_work_rate` 0.21 → 0.00 on a corpus this project
wrote. That corpus has a defect it now discloses: its six duplicate pairs were authored, embedded,
found not to separate, and **rewritten** — so the positives were shaped partly by the detector's
own scores. A dedupe number measured on cases chosen that way cannot settle whether the mechanism
is safe on work it has never seen.

This experiment answers the question the internal corpus cannot, using a test set nobody here
authored and which existed before this project did.

**The claim under test:** at the shipped dedupe threshold, CORTEX does not frequently cancel
distinct work merely because two descriptions are semantically related.

**Why that claim and not a throughput one.** A false dedupe is the most expensive thing this
system can do. It does not slow an agent down — it tells the agent that work it was about to
start is already finished, and the fleet then ships without it. Blocking costs latency; false
dedupe costs correctness, silently.

## 2. The test set

[CooperBench](https://arxiv.org/abs/2601.13295) — *"Why Coding Agents Cannot be Your Teammates
Yet"*, Khatua et al., Stanford and SAP Labs US. MIT licensed. Pinned at revision
`99dfd13988fc32ed90ac3fc41b803dfc3361039e`.

It fits because of one property nothing here can manufacture: its features come in **pools that
are known to be jointly valid**. The authors verified compatibility by producing a joint
ground-truth solution that passes every feature's own unit tests. So for any two distinct features
in one pool, "both of these need doing" is established externally.

**That makes every distinct pair a hard negative for dedupe by construction.** A dedupe that fires
on one is provably wrong, and provably wrong without any judgement from us.

Sizes, taken from the artifact rather than the paper: **199 unique features**, **652 pairs**,
**30 pools**, **12 repositories**, 4 languages.

> **Two numbers that do not agree, quoted to their sources.** The paper says 77.3% of tasks have
> conflicting ground-truth solutions. The shipped `gold_conflict_report.json` says **76.5%**
> (499/652, 0 errors), which is what any script over the data will recompute. Cite 77.3% as the
> paper's figure and 76.5% as the reproducible one; do not present either as the other.

> **`has_conflict` is not a duplication label.** It records whether two golden patches merge
> cleanly — a textual, git-level fact. It is carried into the manifest for stratification at
> analysis time and is used for **nothing** in selection, ordering, or the primary metric. Ordering
> on it would be the exact defect this document exists to rule out.

## 3. Selection

**There is none. All 199 features and all 652 pairs are used.**

This is the strongest available answer to "was the test set chosen on the result", because it
removes the question rather than answering it: there is no sampling rule to inspect, no seed to
have picked, and no subset boundary to have moved. Embedding 199 statements is a few cents, so
sampling would buy nothing but doubt.

The manifest still carries a **published blind ordering** — `SHA256("cortex-20260817" ‖ a ‖ b)`
ascending, computed from feature identity alone — for one reason: if the full run ever proves
impractical, the first N of that order is the subset, and the order was committed before any
distance was known. Using any other subset later would be visible in the diff.

## 4. Method

1. Embed all 199 feature statements with the same model, width and normalisation CORTEX uses in
   production — Titan Text Embeddings V2, 1024 dimensions, normalised. The text is the feature's
   own `problem_statement`, truncated to the same limit `cortex_propose` enforces on a statement,
   and the truncation rule is fixed here in advance: take the feature's **Title** and
   **Description** sections, whitespace-collapsed, cut at the schema's `maxLength`.
2. For each pool, load its features into one repository scope as real `intents` rows, exactly as
   `propose()` writes them.
3. Measure with the mechanism's own SQL. Distances come from CockroachDB's `<=>` on live vectors —
   never from a cosine reimplemented in JavaScript — using the same candidate query
   `propose()` issues (`DEDUPE_CANDIDATE_SQL`), so the number measured is the number the mechanism
   would have acted on.
4. Persist every decision to a benchmark-only table before computing anything. **Every published
   statistic is a SQL aggregate over those rows**, not a counter incremented in a loop — the rule
   `test/workload.test.ts` already enforces on the demo, applied here.

**Two readings are computed and both are reported.**

- **Pairwise**: for each of the 652 pairs, the distance between the two statements, and whether it
  is under the shipped threshold.
- **Pool-level, which is the realistic one**: a feature proposed into a pool where its 8–9
  siblings are already `in_flight` is deduped if the *nearest* of them is under the threshold. This
  is strictly more adversarial than pairwise — more chances to fire — and it is what an agent
  joining a working fleet actually faces. If the two disagree, the pool-level number is the one
  that describes the system.

### Storage

A new table, `bench_cooperbench_proposals`, in `sql/001_init.sql`, carrying at minimum: run id,
pool, proposing feature, nearest candidate, distance, decision, threshold in force, embedding model
and width, and timestamp. Three things follow from the schema audit and are decided here rather
than discovered later — it needs `ENABLE` **and** `FORCE ROW LEVEL SECURITY` plus an explicit
policy, or RLS with no policy denies everything; it must be added to `test/privilege-planes.test.ts`'s
table list, which is hardcoded and would otherwise never probe it; and it must be added to
`test/cli-init.test.ts`'s expected table list, which is also hardcoded and will fail on sight.

## 5. What counts as which outcome — fixed now

Let **f** = false-dedupe rate on distinct features, **r** = recall on true duplicates.

**Primary metric.** `FPR = deduped distinct-feature proposals / distinct-feature proposals`,
at the shipped threshold, pool-level.

| FPR | Verdict |
| --- | --- |
| 0% | strong |
| < 1% | acceptable |
| ≥ 1% | **materially unsafe** — the mechanism cancels required work often enough to matter |
| ≥ 5% | indefensible |

The 1% line is an engineering acceptance criterion, not a literature claim. It rests on the
asymmetry in §1: cancelling required work is not recoverable by retrying.

**True-duplicate recall.** Positives are created mechanically, never authored — the *same*
feature's statement replayed under a second agent id. This is the one construction that cannot be
accused of being written to be caught, because it is not written at all. `r` is the fraction of
those the mechanism catches.

**A curve, not a number.** `P(false dedupe | d)` bucketed at
`0–.20, .20–.30, .30–.35, .35–.39, .39–.45, .45–.60, >.60`. A step at the shipped threshold is
expected and is not the finding; the finding is how much mass sits just below it.

**A second curve — where dedupe stops being worth having.** With true-duplicate prevalence `q`,
utility is `U(q) = q·r − (1−q)·f`, which crosses zero at `q* = f / (r + f)`. **Below `q*`, dedupe
harms more tasks than it saves.** Reported over `q ∈ {0, 5, 10, 20, 40%}`. Publishing that negative
region is the point; the current evidence has no such region and that is its weakness.

**Uncertainty.** Pairs are **not independent** — 199 features across 30 pools, roughly 6.5 pairs
per feature — so a naive interval over 652 would be far too tight. All intervals are a **cluster
bootstrap resampling the 30 pools**, not the pairs.

## 6. What would falsify the claim

Any one of these, and the claim in §1 is false as stated:

- Pool-level FPR ≥ 1% at the shipped threshold.
- `q*` above 20%, meaning dedupe is net-harmful at realistic duplicate prevalence.
- True-duplicate recall `r` below 0.8, which would mean the mechanism is not buying what it costs.

## 7. Objections this does not answer

Stated here so they are not presented later as though they had been.

- **CooperBench is externally authored but deliberately conflict-prone.** It is not a random
  sample of ordinary engineering work, and a low FPR on it does not establish a low FPR on a
  typical repository. It establishes one on a corpus built to make features collide.
- **The corpus is Python-skewed** — 9 of 12 repositories. TypeScript, Go and Rust have one each,
  so no per-language claim is available from it.
- **Feature statements are not intent statements.** CooperBench's text was written to specify a
  feature to an implementer; `cortex_propose` expects one sentence naming intended work. The
  truncation rule in §4 is a fixed, mechanical translation, and it is a translation — an agent
  writing its own statement would phrase things differently, probably better.
- **This measures dedupe only.** It says nothing about claims, blocking, contention, or whether
  arbitration improves joint correctness. Those are experiments 2 and 3.

## 8. Reproducing the manifest

```bash
curl -sSL -o bench/cooperbench/gold_conflict_report.json \
  https://huggingface.co/datasets/CooperBench/cooperbench-dataset/resolve/99dfd13988fc32ed90ac3fc41b803dfc3361039e/gold_conflict_report.json
npx tsx scripts/cooperbench-manifest.mts --check
```

The builder verifies the upstream file against its pinned sha256 and **refuses to run** if it has
moved. That is deliberate: a manifest built on different data is a different pre-registration, and
it needs a new document rather than an edit to this one.
