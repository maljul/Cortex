# Design — the fleet demo

**Date:** 2026-08-12 · **Status:** design approved in conversation, spec under review
**Supersedes nothing.** The current deployed page keeps serving until §11's cold read passes.

This document is the design for replacing the demo's four scripted beats with a real
workload run: five agents, ten tasks, two arms side by side, live database throughout,
and a rebuilt page. It records the decisions Julian made on 2026-08-12 and the reasoning
behind each, so that a later reader does not have to re-derive them.

Every claim below that is not yet verified is marked. Nothing here is a placeholder number.

---

## 1. What this changes, and what it deliberately does not

**Unchanged, and must stay unchanged:**

- the memory model (`03` §2's six tables), the schema, `src/memory/*`, `src/db/retry.ts`
- row-level security and `cortex_demo`'s confinement (U15)
- the privilege planes and `test/privilege-planes.test.ts`
- the published benchmark and its committed results directory
- `bench/cassettes/` as the reproducibility claim
- invariant 8 — no credential field on any demo surface, under any name

**Changed:**

- `POST /demo/run` stops performing four scripted beats and starts executing a real
  curated workload
- the run becomes asynchronous and streamed rather than a blocking request
- the SPA is rebuilt
- a LIVE path exists for the first time, behind a global cap and an unguessable link
- one new table (`live_runs`) — a `03` §2 addition, see §7

---

## 2. Decisions taken, and by whom

All taken by Julian on 2026-08-12, in conversation, with the trade-offs stated at the time.

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | Replay by default; database fully live | live-for-every-visitor | `07` §4 already mandates it; costs cents once; unblocks immediately |
| 2 | Curated cut of `bench/tasks.json` | new corpus; writing task | overlap already engineered; cassettes exist; numbers stay comparable to the published table |
| 3 | Agents emit real patches | intents and findings only | makes "lost write" literal and gives the page something to link to |
| 4 | `design-taste-frontend`, single file, no build step | build step; other taste skills | keeps nothing between source and judge; keeps `test/site.test.ts` working |
| 5 | Four beats dissolve into the run | keep both; beats first | one demo, not two; the curated cut guarantees all four fire |
| 6 | Both arms run simultaneously, split-screen | sequential | contrast without relying on the viewer's memory (`07` §2) |
| 7 | Additive; current page stays live | full replacement | this change cannot cost the submission |
| 8 | Two lanes plus collision moments | memory graph; gantt | the collision is the screenshot |
| 9 | LIVE reached by unguessable link + global cap | password field; no gate | a password field breaks `07` §4, invariant 8, `test/site.test.ts`, and rule B4 |
| 10 | Agents do read → decide → patch (2–3 calls) | single call; full tool loop | a real decision point that dedupe actually changes, inside the run budget |
| 11 | The LIVE run counter lives in a new cluster table | `action_ledger`; DynamoDB | `04` §5 says CockroachDB by name; the increment can share the run's transaction |
| 12 | The naive lane gets the fair stack | today's no-dedupe naive | `01` §3's falsification test, made executable |
| 13 | Cut line is the SPA | cut LIVE; shrink the workload | the runner is the evidence; the page is the presentation |
| 14 | Cap derived from a metered run | fixed cap; cheaper model | no placeholder number reaches a config file |

**On decision 9.** The ask was a password so judges could run real agents. The goal is
right and the mechanism was not: `07` §4's second absolute rule forbids a credential field
on the demo surface "not disabled, not hidden, not present", invariant 8 repeats it,
`test/site.test.ts` fails on any input element, and V32 confirmed zero inputs in the
rendered DOM. A capability URL achieves the same access with no field on the page — the
token rides in the query string, never through an input — and `04` §5 brake 2's global
counter is the cost backstop the password was standing in for.

---

## 3. The workload

A curated ten-task cut of `bench/tasks.json`, against the committed `bench/fixtures/`
service. The cut is chosen so all four beats are guaranteed **by construction** rather
than by script.

| Slice | Tasks | What it guarantees |
|---|---|---|
| two duplicate pairs (differently worded) | 4 | dedupe fires twice |
| one contended trio (overlapping file sets) | 3 | claim collision fires |
| one recall task plus the finding it needs | 2 | recall fires |
| one abandoned task | 1 | the wasted-token path is exercised |

Five agents, two tasks each, per arm. `06` §4 fixes the fleet at 5 and this matches it.

The fourteen-day-old seed stays. A session seconds old cannot honestly hold a memory from
two weeks ago, and the current scenario's practice of seeding it through the same tables
and labelling it as a seed in the response is correct — carry it forward verbatim.

**Task statements are load-bearing and must be measured.** `src/demo/scenario.ts` carries
a comment recording the Titan distances between every pair of its statements, and the
reason: a statement reworded by ear once put the seed 0.2969 from agent-2's intent, inside
the dedupe threshold, which silently deleted beat 4. Any statement added or reworded for
this cut is measured against the others under live Titan before it ships, and the measured
distance goes in the comment. This is not optional and no test can substitute for it.

**Re-recording is required.** "Produce a patch" is a different prompt shape from the
benchmark's, and the cassette key is a hash of the prompt, so the existing cassettes will
miss. Re-record with the demo's own prompts. See §8 for the cost.

---

## 4. The two arms

### 4.1 Two scopes, not one

One `POST /demo/session` creates **two** demo scopes — two rows in `repos`, both carrying
`demo_expires_at` — one per arm. Today both arms share a single scope and are separated
only by using different tables. That works, but the isolation is incidental, and incidental
isolation is the kind that quietly stops being true. Two scopes make it a property of RLS.

Consequences to handle:

- `DEMO_SESSION_ROW_CAP` is per scope, so a visitor now has two budgets. The cortex scope's
  row count rises with the bigger workload; **verify first** that ten tasks stay under 200
  rows, and raise the cap deliberately rather than discovering the ceiling in front of a judge.
- `withRetry(fn, { plane, demoSession })` already scopes per transaction with
  `is_local = true`, so two arms on two pooled connections each carry their own scope
  correctly. Nothing in the retry helper changes.

### 4.2 The naive lane is the conventional stack, run fairly

`06` §2 forbids strawmanning the naive arm, and `01` §3 names the stack people actually
run: a vector store **plus** a lock service. Today's naive lane has neither, which is the
weaker proof and the first thing a database-company judge will push on.

The naive lane therefore runs **the same dedupe search and the same claim, in separate
transactions**. Same embeddings, same statements, same data; only the transaction boundary
differs. That is `01` §3's falsification test made executable — the dedupe passes against a
snapshot that was true a moment ago, and then a lease is taken for work already finished.
It keeps `demo_shared_state`'s last-write-wins read-modify-write, which is where
`lost_writes` comes from.

Concretely: the naive lane writes its intents and claims into the **same tables**, inside
its **own** scope, so both lanes are readable through the same state route and the same
show-SQL panel. What differs is only that its dedupe `SELECT` and its claim `INSERT` are
issued in two `BEGIN` blocks rather than one — which is precisely what the transaction-grouped
panel then puts on screen, side by side with the cortex lane's single block. The contrast
is legible off the transcript without a word of copy explaining it.

**This creates a deviation and the deviation must be published.** The demo's naive arm no
longer matches the benchmark's naive arm as defined in `06` §2, so the two sets of numbers
stop being directly comparable. Requirements:

1. `docs/SPEC-DELTA.md` records it.
2. The page says so where both sets of numbers appear.
3. The benchmark harness and its committed results are **not** touched. Re-running the
   benchmark to match would invalidate the `08` §4 gate four days before ship.

---

## 5. Runtime

### 5.1 The run cannot stay a blocking request

A ten-task two-arm run will exceed API Gateway HTTP's integration ceiling (~30s —
**verify first**, it is a hard boundary and the whole shape depends on it).

- `POST /demo/run` validates, creates the run row, invokes the runner asynchronously, and
  returns `{ runId }` immediately.
- The runner Lambda performs the work and emits events.
- The page receives everything over the existing WebSocket.

### 5.2 Concurrency arithmetic

This account's total Lambda concurrency is **10**, cannot be raised from the CLI, and cannot
be subdivided (V22, V26). One visitor's run must therefore cost **2** invocations — the API
handler and the runner — with all ten agents as async tasks *inside* the runner, sharing the
pool. Ten agents as ten Lambdas would consume the entire account for one visitor.

**Verify first:** the pool's max connections, and whether Basic tier tolerates ten concurrent
sessions from one runner. If it does not, the fleet runs in two waves of five and the page
says so; it does not silently serialise.

### 5.3 Two event sources, labelled differently

| Source | What it carries | Standing |
|---|---|---|
| changefeed | real rows — intents, claims, findings, ledger | authoritative; each carries its primary key |
| runner | fleet activity — agent started, decided, patched | real, timestamped, carries the id of the statement that produced it |

Fleet events are **not** written as rows. Inventing a table to make them into rows is a
`03` §2 memory-model change, which is a stop-and-ask, and it is not worth one. The page
labels the two sources differently so nothing implies a fleet event has a primary key it
does not have.

---

## 6. Measurement — every number's provenance, fixed before the pixel exists

| Metric | Where it comes from |
|---|---|
| `duplicate_work_rate` | `src/memory/duplicates.ts` — the dedupe rule applied after the fact, both arms, distances from the cluster's own `<=>` |
| `lost_writes` | acknowledged writes minus surviving ones, by reading `demo_shared_state` back |
| `claim_p50`, `claim_p95` | server-side timing via `claimLatenciesMs` |
| `serialization_retries` | `getRetryCount` |
| `wasted_tokens` | summed over intents ending abandoned or deduped-after-work |
| `conflicting_edits` | **new** — line-range overlap on the patches, now possible because patches are real |

`conflicting_edits` is the win here: `06` §3 defines it, the benchmark computes it, and the
demo has never been able to. Real patches give real line ranges.

Rules that carry forward unchanged from U16b:

- `test/scenario.test.ts` fails if a meter field is set from a numeric literal or
  incremented without a condition. The equivalent test must exist for the new runner
  **before** the runner does.
- `—` means "this arm has no such thing to measure". `TBD` means nobody measured it. A bare
  `0` for either is the failure.
- Nothing that cannot be measured gets rendered.

---

## 7. The LIVE path

### 7.1 Access

The public page runs replay. An unguessable token in the URL (`/?live=<token>`), pasted only
into the Devpost submission, enables the RUN LIVE control. The token is compared server-side;
it never appears in an input element, and the page contains no field of any kind. If the token
is absent or wrong, the page renders exactly as the public page does — no error, no hint that
a gate exists, per `04` §5 invariant 1.

**Where the token lives, because the repo has been bitten here before.** The expected value is
a Secrets Manager secret, referenced from the stack as a `{{resolve:secretsmanager:...}}`
dynamic reference exactly as every DSN is — never a template value, never a literal in
`infra/`, never injected into `infra/site/index.html` by `scripts/deploy-site.mts`. The first
DSN arrangement leaked one into `cdk.out/` and that is the whole reason the dynamic-reference
rule exists; a demo access token is the same class of thing. The browser only ever holds
whatever the person pasting the link holds, and the page never echoes it back into the DOM.

The comparison is constant-time and the token is **compared, never interpolated** — invariant
7 admits no structural parameter from an agent-reachable path, and a URL parameter is the most
agent-reachable path there is.

### 7.2 The counter

A new table in the cluster, per `04` §5 brake 2 and decision 11. Minimum shape:

- one row per LIVE run, or one counter row per UTC day — **decide at implementation time,
  favouring whichever lets the increment share the run's own transaction**, because a counter
  that can be raced past is not a brake.

Because it is a schema addition, `03` §2's table list changes and `docs/SPEC-DELTA.md`
records it. This is the stop-and-ask CLAUDE.md flagged; it was asked and answered.

**This may subsume U17.** `04` §5 brake 1 (reserved concurrency of 2) is falsified and
unimplemented, and U17's job is to choose a replacement constrained to target the LIVE
reasoning function and nothing else. A global LIVE run counter targets exactly that and
nothing else. Confirm when U17 is reached rather than assuming it here.

### 7.3 The budget, and the number that is still open

`04` §5 targets single-digit dollars for the whole event. `04` §5's default of 40 LIVE runs
per day is almost certainly unaffordable at this workload's size, and the arithmetic is worth
writing down:

- one LIVE run ≈ 10 tasks × 2–3 calls × 2 arms ≈ **50 model calls**
- at roughly 1,500 input and 300 output tokens per call, that is ≈ 75k input and 15k output
  tokens per run

**The rate is not confirmed.** AWS's own Bedrock pricing page has now failed to render the
Sonnet 4.5 row on three separate fetches (two recorded in CLAUDE.md, one on 2026-08-12).
Secondary aggregators agree on **$3.00 per million input and $15.00 per million output**,
which would put a LIVE run at roughly **$0.45**, and single-digit dollars at roughly
**20 LIVE runs for the whole event** — not 40 per day. That figure is an estimate from a
secondary source and is labelled as such everywhere it appears.

**The cap is therefore set by measurement, not by the estimate.** The formula is fixed now:

```
cap = remaining LIVE budget ÷ measured cost of one metered run
```

The measured cost comes from Bedrock's own `usage` on a recorded run, multiplied by the rate
confirmed from AWS Cost Explorer after that run. Until both exist, the config carries `TBD`
and LIVE stays disabled. No estimate reaches a config file.

### 7.4 Honesty

The replay banner stays and keeps its exact meaning: reasoning is cached, database behaviour
is live. LIVE runs say LIVE. Nothing describes replay in language that implies the database
is simulated, because it is not — the arbitration, the retries, the changefeed and the losses
are live in both modes.

---

## 8. Artifacts

Each agent emits a real patch against a copy of the fixture repo.

- **Naive** patches land in `demo_shared_state` and are lost to last-write-wins. The naive
  lane's final tree is literally missing a fix an agent reported as done. That is the
  argument in one screenshot.
- **Cortex** patches are the closed intents' outcomes.
- The page shows both final trees side by side with the missing hunk highlighted, plus a
  link out to `bench/results/`.
- Served through `GET /demo/state` rather than a sixth route, so `05` §5's route list
  does not grow.

---

## 9. The page

Built with the `design-taste-frontend` skill. Single file, vanilla, no build step, no input
elements, endpoints still injected at deploy time by `scripts/deploy-site.mts`.

**Above the fold:** thesis, the published benchmark table, the mode line.

**The hero:** two swimlanes, five agent tracks each, work items travelling. In the naive lane
two items visibly converge on one file and one is destroyed. In the cortex lane an agent halts
at the boundary and a line connects it to the holder. Beat markers light as the real event
fires; if a beat does not fire, the rail says so rather than faking it.

**Below:** the meter, both arms; the two final trees; the show-SQL transcript, still grouped by
transaction so invariant 1 stays readable off the screen.

**Motion rules, each a rule and not a preference:**

1. Every animated element is bound to a real event and hoverable to its primary key or its
   statement id. Nothing loops decoratively while the system is idle.
2. `prefers-reduced-motion` is honoured.
3. No animation implies an ordering the database did not produce. Beat 3's winner is decided
   by the unique index and the page must not pre-position either lane to win.

---

## 10. Invariants this design must not break

Checked deliberately, because each has cost time before:

1. **Dedupe and claim share one transaction** — in the cortex lane. The naive lane splits them
   *on purpose*, and that split is the thing being demonstrated. The show-SQL panel must make
   the difference visible, which is exactly what grouping by transaction already does.
2. All-or-nothing claim acquisition — unchanged.
3. A blocked agent learns the holder — unchanged, and now visible as a drawn line.
4. A deduped agent receives the prior outcome — unchanged.
5. **Every read carries `WHERE repo_id`** — two scopes make this more load-bearing, not less.
6. Every write path wrapped in the 40001 retry helper — unchanged.
7. No agent-reachable path accepts SQL, a table name, or a structural parameter. The LIVE
   token is compared, never interpolated.
8. **No credential field, under any name** — the reason decision 9 went the way it did.

---

## 11. Units and sequencing

Appended to `docs/UNITS.md`. Numbers are not reused. Existing order (U17 → U2 → U18 → U19 →
U20) is displaced by this work; U2 slips behind all of it.

| Unit | Scope | Done when |
|---|---|---|
| U21 | workload runner: curated cut, five agents, fair naive lane, two scopes | ten tasks run to completion in both arms against the real cluster, all four beats observed |
| U22 | async run and streamed events | `POST /demo/run` returns inside the gateway ceiling and the whole run arrives over the socket |
| U23 | measurement completeness: `conflicting_edits`, artifacts, both-arm meters | every rendered number has a test that fails if it is set from a literal |
| U24 | LIVE: `live_runs` table, capability link, metered cap | one metered LIVE run exists and the cap is derived from it, not estimated |
| U25 | the new SPA — **the cut line** | the four beats read clearly to someone who has not seen it |
| U26 | deploy and cold read | Julian opens the deployed page cold and the run reads |

**If time runs out, U25 is cut** and the current page renders the new run through its existing
three panels. Uglier, real, already gate-passed. Nothing built is lost.

Each unit gets the four things `/go` STEP 0 needs, including a named silent break, when it is
written into `docs/UNITS.md`.

---

## 12. Verify-first list

In the repo's sense: invoke it, do not reason about it.

1. API Gateway HTTP's integration timeout (§5.1) — the async shape depends on it.
2. Pool max connections and Basic-tier tolerance for ten concurrent sessions (§5.2).
3. Row count of a ten-task cortex run against `DEMO_SESSION_ROW_CAP` (§4.1).
4. Titan distances for every task statement in the cut (§3).
5. Bedrock's Sonnet 4.5 rate, from Cost Explorer after a metered run (§7.3).
6. That re-recorded cassettes replay with `liveCalls: {embed: 0, reason: 0}` (§3).

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Run wall-clock exceeds `07` §1's ninety seconds | first dedupe must fire inside ~5s; if the run is long, cut tasks — never honesty |
| Pool exhaustion at ten concurrent agents | two waves of five, said out loud on the page |
| Cassette drift after re-recording | re-record wholesale with `--record`, never patch a fixture |
| The rebuilt page is correct and less readable than the one it replaces | only U26's cold read can rule this out — it is the same honest failure mode U16 carried |
| The LIVE link leaks | the global cap is the backstop; that is what it is for |

---

## 14. Spec deltas this design creates

To be written into `docs/SPEC-DELTA.md` as they land, not in advance:

- `03` §2 gains a table (`live_runs`) — §7.2
- `06` §2's naive arm definition and the demo's naive lane diverge — §4.2
- `04` §5 brake 2's "40 LIVE runs per day" default is not adopted; the cap is derived — §7.3
- `07` §3's four beats stop being a script and become observed moments — decision 5
- `05` §5's `POST /demo/run` changes from synchronous to run-id-plus-stream — §5.1
