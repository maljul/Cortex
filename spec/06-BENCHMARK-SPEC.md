# 06 — Benchmark Specification

The benchmark is the submission's central evidence. Judges may score from the
description and video alone, so a reproducible table of numbers does more work than
any feature. Build it on day two, before the UI.

---

## 1. What is being proven

**Claim:** a fleet of agents sharing an arbitrated transactional memory wastes
dramatically less work than the same fleet on the conventional stack, and the
conventional stack loses writes that the arbitrated one cannot lose.

**Falsifiable:** if `duplicate_work_rate` does not drop materially, or if `lost_writes`
is zero in the naive arm, the thesis is wrong and you should say so in the README.
Publishing a negative result you then explain is more credible than a suspiciously
clean win. Judges in a database company have seen manufactured benchmarks.

## 2. The two arms

| | **NAIVE** | **CORTEX** |
| --- | --- | --- |
| Shared state | JSON file on disk, last-write-wins | CockroachDB, SERIALIZABLE |
| Semantic memory | separate local vector store | same cluster, same transaction |
| Arbitration | none | all-or-nothing claims |
| Dedupe | none | pre-action, same snapshot |
| Consolidation | none | changefeed driven |

The naive arm must be a **fair** representation of what people actually do today: a
shared task file plus a vector store. Do not strawman it with something nobody uses.
Its README section should say plainly that this is a reasonable stack, and that the
failures are structural rather than sloppy.

## 3. Metrics

| Metric | Definition | Measurement |
| --- | --- | --- |
| `duplicate_work_rate` | completed intents semantically equivalent to an earlier completed intent, divided by total completed | pairwise cosine below the dedupe threshold, computed offline after the run so the metric does not use the mechanism under test |
| `lost_writes` | writes an agent acknowledged that are absent from final state | diff the union of acknowledged effects against the final repository state |
| `conflicting_edits` | file regions written by two or more agents in overlapping time windows | line-range overlap analysis on the effect log |
| `wasted_tokens` | tokens spent on intents ending `abandoned` or `deduped-after-work` | summed from `tokens_spent` |
| `goodput` | distinct completed tasks per wall-clock minute | |
| `claim_p50`, `claim_p95` | latency of the arbitration transaction | server-side timing |
| `serialization_retries` | count of `40001` retries | counter |

`duplicate_work_rate` MUST be computed by an offline judge that does not share code
with the dedupe path. Measuring a mechanism with itself is the most common way
benchmarks like this become worthless, and a database-company judge will look for it.

## 4. Workload

A fixture repository committed under `bench/fixtures/`, roughly 40 source files
implementing a small service, with a seeded task list of 24 tasks.

Task list composition, chosen so the failure modes are guaranteed to appear:

- 8 independent tasks with no overlap — the control
- 6 pairs of tasks that are **semantically equivalent but differently worded** —
  triggers dedupe
- 5 tasks touching **overlapping file sets** — triggers claim contention
- 3 tasks depending on a finding produced by an earlier task — triggers recall
- 2 tasks that must be attempted and abandoned — exercises the abandoned path

Fleet: 5 agents, started simultaneously, each pulling from the shared task list.

## 5. Determinism

Two different things are often conflated here, and the distinction matters because
judges scan for setup friction:

- **Verifying the numbers requires no setup at all.** The committed results,
  `environment.json`, the cassettes and the offline judge are all in the repository,
  and the hosted demo shows the same mechanism running live. A judge can check the
  claim without provisioning anything. This is what rule B4 is about.
- **Re-running the benchmark requires a cluster**, because database behaviour is
  genuinely live in both arms — that is the point of the harness. A judge who wants to
  re-run it provisions their own free cluster with `cortex init`. That is the CLI
  path, where bring-your-own-credentials is correct, and it is not a restriction on
  the working project.

State both in the README, in that order. Claiming the benchmark reproduces from a
clean clone with nothing else is false, and a database-company judge will be the
first to notice that the CORTEX arm cannot run without a database.

The re-run MUST be reproducible from a clean clone plus a cluster. Non-determinism
from model sampling would destroy that, so:

- Model interactions are recorded to **cassettes** in `bench/cassettes/`, keyed by a
  hash of the prompt. `bench` replays them by default.
- `--record` re-records against Bedrock. Only you run that.
- Fixed random seeds for task ordering and agent think-time jitter.
- Simulated clock offsets so contention is forced deterministically rather than
  hoped for.
- Both arms consume the **same cassettes**. Any difference in results is therefore
  attributable to the coordination layer and nothing else. State that in the README;
  it is the methodological point that makes the numbers mean something.

Note what is and is not simulated: model reasoning is replayed, **database behaviour
is fully live** in both arms. The naive arm really does lose writes to its JSON file;
it is not scripted to fail.

## 6. Output

```
bench/results/
  2026-08-15T14-02Z/
    naive.json
    cortex.json
    summary.md          # the table that goes in the README and the Devpost description
    threshold-sweep.md  # dedupe threshold precision/recall curve
    environment.json    # versions, cluster tier, region, model ids
```

`summary.md` renders as:

```
| metric                | naive | cortex |
|-----------------------|-------|-----------|
| duplicate_work_rate   |  x.xx |      x.xx |
| lost_writes           |     n |         n |
| conflicting_edits     |     n |         n |
| wasted_tokens         |     n |         n |
| goodput (tasks/min)   |  x.xx |      x.xx |
| claim_p50 (ms)        |     — |         n |
| serialization_retries |     — |         n |
```

Commit results. A benchmark whose outputs are not in the repository is a claim, not
evidence.

## 7. Honesty requirements

Non-negotiable, and each one strengthens rather than weakens the submission:

1. Publish the exact command that reproduces the table, and state its prerequisites
   plainly: a free cluster of your own. Publish alongside it what a reader can check
   with no prerequisites at all, which is everything except the re-run.
2. Publish the environment: cluster tier, region, model ids, dates.
3. Report variance across at least three runs, not a single best result.
4. State the limitations section yourself: small synthetic corpus, replayed reasoning,
   single region, one workload shape.
5. If a metric moves the wrong way, publish it and explain it.

A limitations section written by the author is read as confidence. Its absence is read
as either naivety or concealment, and in a field of hundreds of submissions the
difference is decisive.
