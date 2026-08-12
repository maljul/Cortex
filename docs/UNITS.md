# Units of work

The decomposition `spec/11-SHIP-LOOP.md` §5 calls for. Its blocks are three to six
hours, which is too coarse to survive one context — this file cuts them into units
that fit in one, each with the four things `/go` STEP 0 has to output.

**An agent working here does not choose its own scope.** It takes the first unit
not marked done and works only that.

**This file is the status of record.** `11-SHIP-LOOP.md` §2's `lh-log` mentions a
`docs/PROGRESS.md`; do not create one. Two status files drift into contradicting
each other, and a contradicting log is worse than none because it still looks
authoritative. Mark units done here, in place.

> `11-SHIP-LOOP.md` §5 points at `spec/12-DAY-ZERO.md` §4 for the decomposition
> session. **That file does not exist in this repo.** This decomposition was derived
> from `08-BUILD-PLAN.md` plus the invariants in `03-MEMORY-MODEL.md` §8 instead. If
> `12-DAY-ZERO.md` ever turns up, reconcile rather than assume this file is right.

Status: ✅ done · 🔶 partial · ⬜ not started

Day three is deliberately left coarse. Decomposing work that far out invents detail
that will not survive contact with days one and two; cut it into units at the start
of day three, not now.

---

## Day one — the mechanism

### U1 — Schema and migrations ✅
**Done when:** the schema applies to a clean cluster and re-applies without error.
**Specs:** `03` §2
**Evidence:** `sql/001_init.sql`, `IF NOT EXISTS` throughout, applied via `npm run sql`;
grants confirmed by `SHOW GRANTS` in the verification log.
**Silent break:** a column type that quietly differs from the spec — the `VECTOR(1024)`
width, or the `vector_cosine_ops` opclass V1 had to fix.

### U2 — `cortex init` ⬜ **DEFERRED past day two — do not treat as "next"**
**Done when:** "`cortex init` produces a working cluster twice in a row." *(08 §3, 2–5h, verbatim)*
**Specs:** `05` §2, `03` §2
**Verify live first:** that `ccloud` can provision and that a second run is a no-op.
**Silent break:** printing a credential. `05` §2: no command may print one, and
`doctor` must fail loudly if a DSN appears in a tracked file.
**Note:** the migration is already idempotent (U1). This unit is the CLI wrapper
around it and nothing more.

**Deferred 2026-08-09, deliberately.** The rule at the top of this file is "take the
first unit not marked done", which points here — so the deferral is written down
rather than left to be re-derived, because it was re-derived once already and cost a
round of ambiguity over whether U2 or U7 came next.

The reason: nothing is blocked on it. Every downstream unit reaches the cluster
through `CORTEX_DSN`, which already exists, and the schema it would apply is already
applied and idempotent. What U2 buys is onboarding for a stranger — real value, but
it is day three's README-and-first-run value, not day two's proof. Day two's gate
(`08` §4) is a benchmark showing a difference between the arms, and U2 moves that
zero distance.

**Scheduled in day three, after U17 and before U18.** See its entry in that section for
the placement reasoning. If day three runs short, `08` §6 does *not* list it as cuttable,
so it comes before the demo SPA polish, not after.

### U3 — Retry helper ✅
**Done when:** "forced `40001` retries and commits, covered by a test." *(08 §3, 5–9h, verbatim)*
**Evidence:** `src/db/retry.ts`, `test/retry.test.ts` — the conflict is produced by two
real interleaved clients, and a separate test asserts the interleaving genuinely
raises `40001`, so the recovery test cannot pass against a conflict-free harness.

### U4 — Typed layer: keys, propose, close, recall ✅
**Done when:** "all eight pass" — invariants 1–8 of `03` §8. *(08 §3, 9–14h, verbatim)*
**Evidence:** `src/memory/{keys,propose,close,recall}.ts`; 47 tests green against the
real cluster. Test 9 belongs to day three; it needs `cortex_demo` to exist.
**Two deviations from the spec text, both deliberate and commented in place:**
the claim insert uses `ON CONFLICT DO UPDATE` guarded on `expires_at` rather than
`DO NOTHING` (V4: the sweep lands 62–221s late); and `close` runs the ledger insert
first, so the unique index gates the whole operation.

### U5 — Embeddings via Bedrock, content-hash cache ✅
**Done when:** "repeated intent does not re-embed." *(08 §3, 14–16h, verbatim)*
**Evidence:** `src/embed/titan.ts`, `test/embed.test.ts` — 13 tests, of which two
call the live endpoint. Three layers of not-re-embedding: the cache, an in-flight
map, and per-batch deduplication. Removing the in-flight map fails two tests, so it
is load-bearing rather than decorative.
**Verified live 2026-08-09:** Titan accepts `dimensions` and `normalize`, and
returns unit vectors (L2 norm 1.0) at 1024 dimensions.
**Deferred, deliberately:** the cache is per-process. A fleet across machines wants a
shared store, which needs a table `03` §2 does not define. Implement `EmbeddingCache`
against the database when that schema decision is made; do not invent the table.
**Silent break avoided:** the hash covers model and width, newline-delimited, so a
sentence embedded at 512 dimensions or by a later model cannot be served from a
1024-dim entry, and a shifting field boundary cannot collide two different inputs.

### U6 — Two-terminal contention gate ✅ **PASSED 2026-08-09**
**Done when:** "two processes in two terminals contend for one key, one wins, the
loser prints the winner's identity." *(08 §3, end-of-day-one gate, verbatim)*
**Evidence:** `scripts/contend.mts` (one agent, one process) and
`scripts/gate-contend.mts` (`npm run gate:contend`, two processes on a shared start
instant). Five checks pass: one grant, one block, exit codes 0 and 10 per `05` §2,
the loser names the holder, and the loser can reach the winner's intent id. Run
twice; the winner alternated, so it is a real race rather than a systematic
ordering.
**Note for whoever runs it:** the two agents must give *different* statements.
Identical ones dedupe, which is correct behaviour and invariant 4's test, not this
gate's. `contend.mts` says so in its usage text.
**Day two may start.**

---

## Cross-cutting

Not in `08`'s hour blocks. Numbered separately so the `U` numbers the specs refer to
keep their meaning.

### B1 — One module system, and a clean typecheck ✅ 2026-08-09
**Done when:** `npx tsc --noEmit` exits clean and the full suite still passes against
the real cluster.
**Why it was a unit and not a cleanup:** `package.json` said `"type": "commonjs"`
while every source file was ESM, so `npx tsc --noEmit` reported **162 errors** on a
fresh clone and had never once passed. That is the first thing a judge running a
build sees, and Production Readiness is scored.
**Evidence:** `"type": "module"`, `types: ["node"]`, `.js` on all 29 relative imports
in `src/`, `scripts/`, `test/`. `npx tsc --noEmit` exits 0; 71/71 tests pass;
`env:doctor`, `db:check` and the MCP stdio server all still run.
**Five real type errors were underneath the module noise**, all fixed at the type
level with no runtime change:
- `titan.ts` omits `region` rather than passing `undefined`, which
  `exactOptionalPropertyTypes` rejects. The AWS SDK resolves
  `config?.region ?? loadNodeConfig(...)`, so an absent key and an explicitly
  undefined one behave identically — read in the installed SDK source, not assumed.
- Four `noUncheckedIndexedAccess` sites in tests, narrowed by assertions those same
  tests already make.
**Do not let this regress.** `npx tsc --noEmit` belongs in whatever CI day three sets
up; it is cheap and it caught nothing for weeks because nobody could run it.

### B2 — Deploy spike: a hello-world through the full AWS pipeline ✅ 2026-08-10
**Done when:** a Lambda deployed by IaC answers over API Gateway with the cluster's own
build string, and a CloudFront URL serves a page, both reachable from outside the account.
**Why it was a unit:** `08` §7 prescribes this for day one evening and it did not happen.
"Deployment eats day three" was the medium-likelihood, high-impact risk in the register.
**Evidence:** `infra/` — `lambda/identity.ts`, `bundle.mjs`, `cdk-spike/`, `site/`. V22
has the output. Suite 174/174, `tsc` clean.
**`04` §2's `[OPEN]` is closed: CDK.** Both tools were built and timed. The section's own
tiebreaker — redeploy under ten minutes — **tied**: CDK 42s, SAM 33s, both ~15× inside
the bar. Decided instead on what the templates look like for U14's remaining resources.
**The risk it was written to burn down did not fire.** Lambda reaches CockroachDB Cloud
with no custom CA, no VPC and no `sslmode` change; the module-scope pool survives between
invocations, so a warm request queries in 3ms.
**Two findings that did fire, and both matter more than the `[OPEN]`:**
- **Lambda concurrency is capped at 10 on this account**, not 1000. Thirty concurrent
  requests returned twenty `503`s and the database was never the bottleneck. This is a
  constraint on U17 and a risk to rule B4; the quota increase is Julian's to file.
- **The first stack put the reader DSN in the synthesized template**, satisfying `05` §6
  as written while leaving the credential in `cdk.out/` and in CloudFormation's stored
  copy. Now a `{{resolve:secretsmanager:...}}` dynamic reference. Found by grepping the
  artifact, not by reasoning about the rule.
**For whoever deploys next:** `node infra/bundle.mjs` before every `cdk deploy`. Nothing
runs it automatically, and a stale bundle deploys silently — which is why the handler
carries a `BUNDLE_REVISION` you bump by hand.

---

## Day two — the proof

### U7 — MCP server skeleton, stdio transport ✅ 2026-08-09
**Done when:** a client lists the three write tools over stdio and gets the schemas
from `05` §3 verbatim.
**Specs:** `05` §3
**Silent break:** rewording a tool `description`. Those strings are prompt surface,
not documentation — they are what makes an unmodified third-party agent behave
correctly. Copy them.
**Evidence:** `src/mcp/{tools,server}.ts`, `scripts/serve-mcp.mts` (`npm run serve`),
`test/mcp.test.ts` — 11 tests. The listing tests spawn the server as a child process
and speak MCP over pipes; nothing imports it in-process, so a passing test means the
transport works and not merely that a handler runs. The schema tests parse the JSON
blocks out of `spec/05-INTERFACES.md` §3 at run time rather than snapshotting them,
so a reworded `description` fails instead of drifting — the silent break above is the
one thing this unit's tests are actually built around. Also driven with a hand-written
JSON-RPC handshake and no SDK on the client side, which confirms stdout carries
protocol frames only.
**Three mutations were run to show the tests are load-bearing:** rewording a
description fails 2; deleting the undeclared-argument check fails 1; adding an
`auth_token` field fails 3.
**Deviation from spec text, deliberate:** `05` §3's blocks omit
`additionalProperties`, so the schemas document a closed field list without enforcing
one. The server rejects any argument the schema did not declare. Invariant 7 is a
claim about what reaches a handler, not about what a schema says, so it is enforced
on the boundary now rather than left to U8.
**No handler is implemented, on purpose.** Calling a tool returns a not-implemented
error and never `granted`/`blocked`/`deduped`; a test asserts that. Arbitration
belongs in `src/memory/`'s single transaction, and a handler wired up ahead of it is
how invariant 1 breaks quietly.
**Spec gap found and closed:** §3 gave `cortex_heartbeat` prose and no JSON block.
The block was written into §3 from §1's `heartbeat(repo, intentId, extendBy?)`, and a
test now holds the two sections against each other.

### U8 — `cortex_propose` tool ✅ 2026-08-09
**Done when:** a real coding agent attaches and successfully proposes. *(08 §4, 16–20h)*
**Specs:** `05` §3, `03` §4.2
**Silent break:** letting `blocked` or `deduped` surface as a tool error. They are
normal return values; an agent that sees an error will retry through a block, which
turns the fleet into a queue — the exact behaviour `03` §5 forbids.
**Evidence:** `src/mcp/{server,validate}.ts`, `src/memory/repos.ts`,
`test/propose-tool.test.ts` — 13 tests, every one over a child process speaking MCP
on pipes, no stubs. 86/86 suite green, `npx tsc --noEmit` clean. All three decisions
were also driven out of `npm run serve` by a client with **no MCP SDK at all**, raw
newline-delimited JSON-RPC; that transcript is in the verification log and is the
closest thing to the literal done-when that can be captured as text.
**The named silent break is the load-bearing assertion.** Mutating the handler to
return `isError: true` alongside a correct decision fails 5 tests. A second mutation
— resolving the repo before validating the keys — fails 1.
**Two decisions this unit had to take, both in `docs/DECISIONS.md`:** `repo` is a
slug and had to be resolved to a `repo_id` (nothing before U8 derived the tenant
boundary rather than being handed it), and `glob:` keys are never narrowed to a bare
`glob:` row. **Extended 2026-08-10:** `05` §6 gained `CORTEX_REPO_ROOT` and the server
now expands a glob against it — one claim per matched file plus the glob — so §3's
advertised grammar is fully served. Unset, it still refuses.
**Two bugs U7 could not have seen**, both because it had no handler that read the
environment: `scripts/serve-mcp.mts` never loaded `.env`, so `npm run serve` had no
DSN; and a module-scope `Embedder` would have read `BEDROCK_REGION` before the entry
point loaded it. The embedder is now lazy, like `db/pool.ts`, for that reason.

### U9 — `cortex_close` tool ✅ 2026-08-09
**Done when:** a granted intent can be closed exactly once through the tool surface,
and a long intent can extend its lease.
**Specs:** `05` §3, `03` §4.3
**Silent break:** `heartbeat` extending a lease the caller no longer holds. It must
verify the holder, or a dead agent's lease gets renewed by whoever asks.
**Not yet implemented at all:** `heartbeat` and `release` from `05` §1.
**Decision 2026-08-09 — do not implement lease extension.** Heartbeat is cut-list
item 6 (`08` §6), and it is being taken up front rather than under time pressure: use
a longer fixed lease and leave the tool advertised but returning not-implemented. Its
schema is settled in `05` §3 and served by U7, so this stays a scheduling decision and
nothing downstream has to be reshaped if it is revisited. **U9 is therefore
`cortex_close` only.** That is an hour off the critical path.
**Evidence:** `src/mcp/server.ts` `handleClose`, `requireRepoId` in
`src/memory/repos.ts`, `test/close-tool.test.ts` — 10 tests over a child process on
pipes, closing intents that were granted through `cortex_propose` on the same wire
rather than rows a test inserted for itself. 96/96 suite green, `tsc` clean. The
propose → close → redeliver → second-close → heartbeat sequence is in the
verification log, driven by a client with no MCP SDK.
**Exactly once, the whole unit, has three distinct answers** and each is asserted:
a redelivery under the same key returns `applied: false` and releases nothing; a
second close under a *new* key is an error and leaves no ledger row, because `03`
§4.3's ledger-insert-first ordering takes it down with the rollback; and a close
against another tenant's intent fails without touching it.
**One decision this unit had to take** (`docs/DECISIONS.md`): `cortex_close`
*requires* its repo to exist where `cortex_propose` registers one. A close can never
legitimately be the first thing a repository sees, so a typo'd slug that minted a
tenant and then answered "no such intent here" would send the caller after the wrong
bug. Mutating the handler back to the registering resolver fails that test.
**Where the error line falls, and why:** a malformed argument throws before anything
is attempted, so it is a protocol error; a well-formed call about a state the agent
has wrong — already closed, unknown repo — comes back as `isError` with the
explanation, which is what an agent can act on. Unlike `blocked` in U8, neither is a
value an agent should proceed from.

### U10 — Agent Skill over the `cortex_reader` read path ✅ 2026-08-10
**Done when:** "agent recalls without any bespoke client." *(08 §4, 20–23h, verbatim)*
**Specs:** `05` §4, `03` §4.1
**Silent break:** shipping recall SQL in the skill that drops a `repo_id` predicate.
There are **two** — the one in the `near` CTE and the one on the `LEFT JOIN` — and V14
measured what losing the second does: repo A's recall ranked on repo B's revert
history. Per V5 a missing filter fails open rather than failing closed, and this is the
one query that leaves the repository.

**The unit was reshaped by a decision, not merely unblocked.** It was
"Agent Skill and the managed-MCP read path" until 2026-08-10. V17 measured the managed
MCP server writing to `claims` — it executes as `managed-mcp`, which holds INSERT and
DELETE there, confirmed by invoking `insert_rows` and getting **23502** rather than
**42501**. Julian chose to drop that route rather than try to constrain its principal.
Reads are now issued directly as `cortex_reader`. Reasoning in `docs/DECISIONS.md`;
`04` §1, §3 and §4 and `05` §3, §4 and §6 are corrected in place.

**So the skill ships SQL against `CORTEX_READER_DSN`,** and the "governed by Cloud
RBAC" argument is replaced by "governed by a SQL grant, and `test/privilege-planes.test.ts`
attempts nine writes as that principal and requires all nine to refuse with 42501".
That is a stronger claim and it is already under test.

**Pin the SQL, do not retype it.** `skills/cortex-memory/SKILL.md` must carry the
recall query byte-for-byte from `src/memory/recall.ts`, with a test holding the two
together the way `test/mcp.test.ts` holds the tool schemas against `05` §3. Retyping is
how a predicate goes missing, and the failure is silent.

**Established live and not needing redoing:** the recall SQL runs correctly under
`cortex_reader`'s privileges, and its plan uses `findings_semantic` with the tenant
prefix bounding the search (V9). `cortex_reader` is read-only by attempted write, not
by catalogue (V15).

**Nothing here is blocked any more.** The `CORTEX_MCP_*` variables stay in `.env` as
diagnostics for `npm run probe:read` only; do not reintroduce that server as the route
without re-running the probe.

**Evidence:** `skills/cortex-memory/SKILL.md` (all six sections `05` §4 numbers),
`RECALL_SQL` now exported from `src/memory/recall.ts`, and `test/skill.test.ts` — 6
tests. V21 has the output. Suite 174/174, `tsc` clean.
**The SQL is pinned byte-for-byte**, with a *separate* assertion that both `repo_id`
predicates are present — the equality alone would still pass if someone edited both
files together. Deleting `AND i.repo_id = $2` from the skill, which is V14's exact
failure, fails both tests.
**"Without any bespoke client" was taken as far as this machine allows:** the live test
opens a plain `pg` client on `CORTEX_READER_DSN`, lifts the query out of the published
markdown, and gets rows — no `src/memory/` in the path. `psql` is not installed here, so
this is a driver-level proof rather than a command-line one. **A `psql` take is worth
recording for the video**; it is the more convincing form of the same claim.
**Section coverage is parsed from `05` §4 at run time**, not snapshotted, so rewording
the spec fails the test rather than silently disagreeing with it.
**One thing the skill must say that §4 does not mention:** how to obtain `$1`. Recall is
a distance query, so the agent needs its text embedded by the same model at the same
width, or the distances mean nothing. The skill gives the Titan model id, the width, and
an AWS CLI invocation.

### U11 — Benchmark fixtures and task list ✅ 2026-08-10
**Done when:** the corpus and the overlapping-task share exist and are committed.
**Specs:** `06`
**Silent break:** too little task overlap. `08` §7 names this: a benchmark showing no
difference means overlap is too low, not that the mechanism does not work.
**Evidence:** `bench/fixtures/` (40 source files, a small orders service),
`bench/tasks.json` (30 tasks), `bench/tasks.ts`, `test/bench-fixtures.test.ts` — 13
tests. Measured overlap: **13/30 contending (43.3%), 6/30 redundant (20.0%)**. V11
has the numbers.
**The silent break happened, and was caught by measurement on the first run.** The
six "semantically equivalent" pairs were written, then embedded: all six landed
between 0.4380 and 0.7068, with the closest non-pair at 0.4293 — nothing separated,
and a benchmark built on that draft would have reported that arbitrated memory does
not reduce duplicate work. They had been reworded *adversarially*, sharing no
vocabulary; rewritten as ordinary rephrasings they separate at (0.3630, 0.4293).
Reading them aloud never revealed it.
**The test asserts separability, not the 0.28 constant** — deliberately. `03` §4.2
marks the threshold `[OPEN]` and empirical, so a fixture asserted against today's
value would be tuned to the mechanism it exists to measure. What it does assert at
the shipped value is **precision**: a false positive means the CORTEX arm skips work
that needed doing and books the saving as a win.
**Finding for U13:** `0.28` sits below the band and catches 4/6 pairs with 0 false
positives. Something in (0.3630, 0.4293) catches all six. Nothing was changed in
`src/memory/propose.ts` — picking it is the sweep's job, in `docs/SPEC-DELTA.md`.
**Spec contradiction found and corrected:** §4 said 24 tasks while its own bullets
summed to 30. Julian settled it in favour of the bullets; `06` §4 now says 30.

### U12 — Five-agent runner and cassettes ✅ 2026-08-10
**Done when:** "`cortex bench` runs both arms deterministically." *(08 §4, 23–29h, verbatim)*
**Specs:** `06`
**Silent break:** non-determinism leaking in through model calls or wall-clock time,
so two runs of the same arm disagree and the published number is unreproducible.
**Evidence:** `bench/{run,scheduler,cassettes,reason,rng,types}.ts`,
`bench/arms/{shared,naive,cortex}.ts`, `src/memory/history.ts`, `scripts/bench.mts`
(`npm run bench`), 30 reasoning + 30 embedding cassettes committed under
`bench/cassettes/`, and `test/bench-runner.test.ts` — 12 tests. V19 has the output.
Suite 156/156, `tsc` clean.
**The named silent break is the load-bearing assertion.** The test runs *each arm
twice* and compares the decision sequences; a determinism test that inspected one run
could not fail for the reason it exists. Adding `+ (Date.now() % 7)` to one step
duration fails that test and nothing else.
**Determinism is bought with a trade, and it is written down** (`docs/DECISIONS.md`):
one step runs at a time on a simulated clock, so contention is real and reproducible
but two transactions never overlap. This harness produces no `40001`s and its
`claim_p50` is an uncontended latency. U6 and V13 are where the real race is proven;
U13 must report those two metrics as what they measure.
**Cassettes are recorded by a prefetch over the whole task list**, not as a side effect
of a run — otherwise the committed library would depend on which arm ran, since CORTEX
never reasons about what it dedupes.
**Two findings for U13, both honest-against-us:** CORTEX recall returns 0 every time
because consolidation (`03` §4.4) is not built while NAIVE reads its own local notes,
so the three recall-dependent tasks understate CORTEX; and the naive arm loses 21 of
28 acknowledged writes, which is what last-write-wins on a whole-file rewrite does and
needs the mechanism published beside it.

### U13 — Metrics, duplicate judge, results writer ✅ 2026-08-10 — **GATE PASSED**
**Done when:** "`bench/results/` populated and committed." *(08 §4, 29–32h, verbatim)*
**Specs:** `06`
**Silent break:** a placeholder number reaching a results file. Write TBD.
**End-of-day-two gate:** the summary table shows a real difference between the arms.
From that moment the project is submittable even if everything else fails.
**Evidence:** `bench/{judge,metrics,environment}.ts`, `src/db/identity.ts`,
`scripts/bench-results.mts` (`npm run bench:results`), `bench/results/` committed with
all five files `06` §6 asks for, and `test/bench-metrics.test.ts` — 12 tests. V20 has
the table. Suite 168/168, `tsc` clean.
**The gate, median of three runs**, as republished 2026-08-11 (V23) after `03` §4.2's
threshold `[OPEN]` was closed: `duplicate_work_rate` 0.21 → 0.00, `lost_writes` 21 → 0,
`conflicting_edits` 3 → 0, `wasted_tokens` 4000 → 867, goodput 38.16 → 200.73 tasks per
simulated minute. **The gate passed on 2026-08-10 at the old threshold** — 0.21 → 0.08,
4000 → 1975, goodput 180.23 — and that run is not kept alongside this one, because two
published tables make a reader guess which is quoted. The prior figures live here and in
V20; the artifact is singular on purpose.
**The named silent break is the load-bearing assertion,** and it needed a distinction
the spec does not draw: `—` means this arm has no such thing to measure, `TBD` means
nobody measured it, and a bare `0` for either is the failure. Mutating the rate to
return 0 instead of TBD when there is no denominator fails one test and nothing else.
**The judge cannot reach the mechanism.** `bench/judge.ts` imports nothing from `src/`
and a test greps its import list. It reads the committed vectors off disk and computes
its own cosine, so `duplicate_work_rate` is recomputable from a clean clone with
nothing provisioned.
**CORTEX was 0.08 rather than 0.00 when this unit closed, and that was the useful half.**
The then-shipped 0.28 caught 4 of 6 declared pairs; the judge scores at 0.40, inside the
band where recall and precision are both 1.000, so the two residual duplicates were
exactly the pairs 0.28 missed. `src/memory/propose.ts` was **not** edited inside this
unit — moving the mechanism's constant inside the unit that scores it is the circularity
`06` §3 forbids. **Julian closed the `[OPEN]` at 0.39 on 2026-08-11 (V23)**, as a
separate act with the sweep in front of him, and the row is now 0.00. That sequence —
measure, publish, then decide — is the thing that makes the change not circular, and it
is disclosed in `summary.md` rather than smoothed over.
**Two metrics mean less than §3 implies, and say so in `summary.md`:**
`serialization_retries` is 0 by construction under the serialised scheduler, and
goodput is per simulated minute because wall-clock goodput would compare a local file
write against a cloud round trip.

---

## Day three — the surface

Decomposed 2026-08-10 from `08` §5 and §6, at the start of day three as the previous
version of this section instructed. Every done-when below is **verbatim from `08` §5**;
where a unit needs a condition §5 does not give, it is marked as added and why.

`U` numbers are not reused or renumbered — `docs/UNITS.md`'s own rule is that the numbers
the specs refer to keep their meaning. **U2 keeps its number and is scheduled here**, in
the position its dependencies put it, rather than being renamed into the day-three run.

Order of work: **U14 → U15 → U16 → U17 → U2 → U18 → U19 → U20.**

### U14 — Infrastructure as code, deploy, changefeed to WebSocket ✅ 2026-08-11
**Done when:** "hosted demo reachable anonymously." *(08 §5, 32–38h, verbatim)*
**Specs:** `04` §2, `05` §5, `04` §5

**Evidence:** `infra/cdk/` (renamed from `cdk-spike/`, stack `CortexStack`),
`infra/lambda/{identity,demo,changefeed,connections}.ts`, `src/db/pool.ts` planes,
`src/demo/{api,stream}.ts`, `src/memory/demo.ts`, `scripts/{deploy-secrets,deploy-site,
changefeed,gate-stream}.mts`, and `test/demo-{plane,stream}.test.ts` — 27 tests. V26 has
the output. Suite 197/197, `tsc` clean.

- **Site** https://d11xbslgdgomdp.cloudfront.net · **API**
  https://clotk5952m.execute-api.us-east-1.amazonaws.com · **stream**
  `wss://4hiryvz6yd.execute-api.us-east-1.amazonaws.com/live`
- `npm run gate:stream` is the reproducible proof and **it is the take to record for the
  video**: a session taken anonymously from the hosted API, a real row written as
  `cortex_demo`, and the cluster's own changefeed delivering it to a browser socket in
  126ms. V25 explicitly refused to claim delivery; this is where that closes.

**The named silent break did not happen, because the shape that caused it was removed.**
`getPool()` now takes a plane and each plane reads its own variable, so no single DSN can
promote one function's privileges into another's. It was replaced by a smaller version of
itself that is worth reading: the identity handler still asked for the default *write*
plane on the first deploy while holding only the demo DSN, and answered `CORTEX_DSN is
empty` — the separation failing **closed and naming the missing variable** instead of
connecting as somebody else.

**`04` §5's brake 1 is falsified and is not implemented.** Reserved concurrency cannot be
set on this account **at any value**: AWS refuses a reservation that drops unreserved
concurrency below 10, and the account's total is 10. V22 found the pool small and
unraisable; U14 finds it indivisible. The budget is written down in
`infra/cdk/lib/cortex-stack.ts` as §5 asks — four functions sharing 10, none reserved —
and choosing a replacement brake is left to U17 with the ladder it already owns. See
`docs/SPEC-DELTA.md`.

**Two of `05` §5's five routes are deliberately U16's**, and the reasoning is in
`docs/DECISIONS.md`: `POST /demo/run` starts `07` §3's beats in a mode `04` §5 governs,
and `GET /demo/sql-log` is the panel U16's own silent break is written about.

**Also found:** `03` §7's "demo rows MUST be reclaimed automatically" is half built —
expiry makes a scope unreachable at read time and is tested, but nothing deletes the rows,
and a blanket TTL would reach real memory. Recorded in `docs/SPEC-DELTA.md` rather than
guessed at, because the fix is a `03` §2 schema decision.

### U15 — `cortex_demo` confinement, and `03` §8 test 9 ✅ 2026-08-11
**Done when:** `cortex_demo` cannot read or write any row outside a live demo session
scope, asserted by attempting the writes against the real principal. *(Added: `08` §5
has no block for this, because it is `04` §3's `[OPEN]` rather than a build step. It
gates U16, which writes as this principal.)*
**Specs:** `04` §3, `03` §7, `03` §8
**Verify live first:** that Row-Level Security works on Basic tier — enable it on a
scratch table, attach a policy, and confirm a non-owner is actually filtered. `04` §3
requires real memory to be **unreachable to the principal**, not filtered out of its
queries, and a table-level `GRANT` cannot give that. If RLS is unavailable, **stop**:
the alternative is a second cluster and that is a decision, not a fallback.
**Silent break:** granting the DML and forgetting `FORCE ROW LEVEL SECURITY`, or
enabling RLS without a policy on one of the six tables. Either leaves a table wide open
while the other five look correct, and `test/privilege-planes.test.ts` iterates all six
precisely so that a per-table miss cannot hide behind a passing suite.
**Note on the existing test:** its demo block asserts the *weaker* current state —
"`cortex_demo` holds no privilege at all" — and its header says it is written to fail
loudly once scoped grants exist. **That failure is the signal to rewrite it into test 9,
not a regression to undo.**
**Schema:** `repos` has no demo-scope marker. It needs one (`03` §7 also requires demo
rows to carry a TTL), added `IF NOT EXISTS` so U1's idempotence survives.

**Evidence:** `sql/001_init.sql` (`repos.demo_expires_at`, `is_current_demo_scope()`,
grants, `FORCE ROW LEVEL SECURITY` and 18 policies), `test/privilege-planes.test.ts`
rewritten — 23 tests, 9 of them test 9. V24 has the output. Migration applies **61/61
twice in a row**. Suite 170/170, `tsc` clean.
**RLS was verified live before a line was written**, and both obvious spellings of the
policy were refused: CockroachDB policy expressions cannot contain a subquery
(`EXISTS (SELECT … FROM repos …)` → 42P01, `IN (SELECT …)` → 42703). A `STABLE` function
is the way through. Not `LEAKPROOF` — this cluster requires leakproof to be `IMMUTABLE`.
**The named silent break happened in a form not anticipated.** The unit predicted
"forgetting `FORCE`, or missing a policy on one of six tables". What actually bit was
`CREATE POLICY IF NOT EXISTS`: it **silently skips** when the name exists, so adding the
session condition applied cleanly to a fresh cluster and did nothing to the live one —
the migration reported success while the cluster kept the old rule. Every policy is now
DROP-then-CREATE so the file converges rather than skips.
**Three mutations were run, and the second one is why this unit is worth reading.**
Stripping the session condition from both layers fails 3 tests. Stripping the *demo
scope* condition — the more important one — initially failed **only** the expiry test:
every other assertion scoped the connection to a legitimate session and then reached
elsewhere, so the session predicate alone refused them. The suite could not distinguish
"confined to demo scopes" from "confined to the named session". A test was added for the
case that actually matters — a compromised or buggy write path naming a **real
repository as its own session** — and it now fails on that mutation. `demo_expires_at IS
NOT NULL` is what holds there, and nothing had been checking it.
**What this does not claim.** Session-versus-session isolation is defence at the write
path, not at the account boundary: every visitor is the same SQL user and there is no
SQL role per anonymous visitor to be had. What it buys is failing **closed** — no
`cortex.demo_session` set, nothing visible — which is V5's failure mode inverted. Said
plainly in `04` §3 rather than left for a reader to infer.

### U16 — Demo SPA: three panels, naive toggle, show-SQL 🔶 **built and deployed; reads cold, unconfirmed**
**Done when:** "the four beats read clearly to someone who has not seen it."
*(08 §5, 38–44h, verbatim)*
**Specs:** `07` §2, `07` §3, `05` §5

**Done (2026-08-11, V27 + V28) — everything the SPA renders:**
- **Consolidation is built** (`03` §4.4, `src/memory/consolidate.ts`), so beat 4 is a real
  mechanism rather than a cut. `npm run gate:consolidate` proves it end to end: close →
  changefeed → Bedrock → finding → back over the socket in 502ms. Julian's call on
  2026-08-11 was to build it rather than cut the beat.
- **All five of `05` §5's routes exist.** `POST /demo/run` performs the beats in either
  arm against the real cluster; `GET /demo/sql-log` returns the run's actual statements.
- **The show-SQL panel cannot lie.** `src/db/recorder.ts` wraps the live client, so a
  statement reaches the log only by having gone to the driver — the named silent break,
  closed by construction rather than by care. The log shows one `BEGIN` containing the
  dedupe search and the claim insert, so invariant 1 is readable off the panel.
- `propose`, `close`, `recall` and `consolidate` all take a plane and a demo session, so a
  visitor's arbitration is the same transaction under `cortex_demo`'s RLS.

**The SPA is built and deployed (2026-08-12, V29).** `infra/site/index.html` — three
panels, the naive toggle, the show-SQL view — at https://d11xbslgdgomdp.cloudfront.net.
Vanilla, one file, no build step; `scripts/deploy-site.mts` injects the endpoints because
they are CloudFormation outputs. `test/site.test.ts` guards invariant 8 against the source:
no input, form or credential-shaped name, including commented out.
Three backend gaps were closed to feed it — `action_ledger` reaches `demoState()` and the
changefeed so `03` §2's fourth tier has a source, claim p50 and the retry counter are
measured from the run per `04` §7, and `GET /demo/state` reports the mode and its reason per
`05` §5. **Recreating the changefeed is required after touching `WATCHED`**; the procedural
tier stays empty until `npm run changefeed create` runs.

**The page has now been driven in a browser (2026-08-12, V32), and the mechanical half is
confirmed.** All four beats fire; the show-SQL panel puts the dedupe search and the claim
insert inside one visible `BEGIN` so invariant 1 is legible off the screen; both arms populate
the meter; and invariant 8 holds against the **rendered DOM** — three buttons, zero inputs —
which is stronger than `test/site.test.ts`'s source scan. No console errors.

**What is left is still the one thing no script can do: read it cold.** V32 was a *driven*
read — `docs/UNITS.md` had been read first, so the beats were known before the page was
opened. The done-when is "someone who has not seen it", so it needs a reader who has not.
**Julian opens it, and says whether the beats land.** Until then this unit is not done, and
the honest failure mode is a page that is correct and unreadable.

**Three defects V32 found, none of which a test would have caught.** (1) Beat 1's
`NOTHING KNOWN` carries no explanation in the cortex arm while the *naive* arm's identical
badge carries one — so the winning arm is the one with the unexplained blank, two columns from
a semantic tier displaying findings about the very subject agent-1 asked about. That is the
one to watch a cold reader hit. (2) The show-SQL button's sub-label does not toggle with its
label. (3) `CLAIM P50` naive stays `—` where every other row has both sides.

**U16b (2026-08-12, V30) — the agents are real and the NAIVE column is measured.** Two things
were wrong and both were found by reading the code rather than the screen. They are fixed.

- **The NAIVE column was fabricated.** `meter.duplicateWorkDone += 1` and
  `meter.lostWrites += 1` were unconditional, and the naive arm executed **zero statements**,
  so there was no write to lose and nothing observed the losing. Two constants were rendered
  in the same table and the same style as figures the driver had timed — `07` §1 and rule A7,
  broken. The naive arm now performs its work against the database through
  `src/memory/shared-state.ts` (`repos.demo_shared_state`, a JSONB cell read whole and written
  back whole, which is `06` §2's last-write-wins against a row instead of a file), and the
  losses are **measured by reading the cell back**: acknowledged writes minus surviving ones.
- **Beat 3 is now a real race.** The two contenders propose concurrently on their own pooled
  connections and CockroachDB's unique index decides. `SCRIPT.claimWinner`/`claimLoser` are
  renamed `contenderA`/`contenderB`, because a name that is false on half the runs is worse
  than a dull one, and no test may assert which one wins. **Beat 2 stays a sequence** — dedupe
  is a temporal relationship and racing it would delete the beat rather than harden it
  (`docs/DECISIONS.md`).
- **`duplicate work done` is measured for both arms by one rule** (`src/memory/duplicates.ts`):
  the dedupe threshold applied after the fact to whatever each arm actually did, with the
  distances computed by CockroachDB's own `<=>` so the number on screen comes from the
  database. CORTEX scores 0 because its duplicate agent was deduped and did no work; NAIVE
  scores 1 because nothing stopped either of them. Same rule, two inputs.
- **The guard is a source-text test** (`test/scenario.test.ts`): no meter figure may be set
  from a numeric literal, and an increment must be guarded by a condition on its own line.
  Its first version was itself wrong — it flagged the file's header, which quotes the two
  fabricated lines while explaining them — so comments are stripped before the scan and a
  separate assertion proves the stripping did not eat the file.
- **The show-SQL panel groups by transaction.** Concurrency interleaves two BEGINs, which
  destroys the one thing the panel exists to show; `RecordedStatement.txn` restores it and
  makes it stronger — two transactions overlapping in time, each holding its own dedupe
  search and its own claim insert.
- **`serializationRetries` is non-zero for the first time in this project** (measured 1–3 per
  CORTEX run), which closes U12's note that the benchmark's serialised scheduler makes that
  metric 0 by construction.

**One finding this unit surfaced and Julian closed the same day.** Genuine
concurrency made `03` §5's five-attempt cap reachable — both beat-3 agents exhausting it on
about **one run in twelve**. `backoffMs` sleeps 20–320 ms in total while a propose transaction
takes about a second, so two colliding agents restart into each other. The demo now follows
§5's own next sentence — an agent that has lost fast **re-plans**, once, visibly
(`replanOnce`), and Julian chose the larger base delay: **`BASE_DELAY_MS` 20 → 250** (V31),
which took exhaustions from **1/12 to 0/12** and settled retries at 1. Every documented
property of `backoffMs` survives because each is relative to the constant, so
`test/retry.test.ts` needed no edit. The five-attempt cap is untouched — raising it would
contradict §5 — and `replanOnce` stays, because it is §5's instruction rather than a
workaround for it.

**LIVE reasoning (`U16b` §3c) is NOT built, and is blocked on two things Julian owns.**
`04` §5 brake 2 — the global run counter — has nowhere to live but a new table, and `03` §2's
six tables are the memory model; U16b itself says to stop and ask before adding one. And §6
requires the actual Bedrock rate for Sonnet 4.5 written down before LIVE is enabled: two
fetches of AWS's pricing page did not return it, so it is **TBD** and the rule against
placeholder numbers applies. Everything the spend would be measured against is ready — the
committed cassettes put one reasoning call at ~501 input and ~72 output tokens (max 1067/111),
so five agents is on the order of 3k tokens per run.

**Beat 1 does not fire, and that is a decision waiting, not a bug.** `03` §4.1's published
SQL filters recall at `dist < 0.35`, and under real Titan embeddings every honest wording
of the seeded finding sits 0.38–0.47 from the task it is about. The run reports "nothing
known", truthfully. **Do not move the constant to make the beat work** — that is `06` §3's
circularity, and the precedent is `03` §4.2's threshold, which Julian closed separately
with a sweep in front of him.

**That sweep now exists for recall too, and the constant is CLOSED at 0.60 (2026-08-12,
V33/V34).** `npm run sweep:recall`, published beside the dedupe one at
`bench/results/2026-08-12T18-35-38-014Z/recall-threshold-sweep.md`, against ground truth in
`bench/recall-truth.json` written before anything was measured. At 0.35, **one query in eight**
got any relevant finding back; 0.60 is the largest tested value that still returns nothing
irrelevant; the first false positive is at 0.63. The ordering argument is what makes the change
non-circular and it predates the demo's need for it — recall at 0.35 being *tighter* than dedupe
at 0.39 is backwards, because a dedupe false positive cancels real work while a recall false
positive costs attention. **0.60 is the top of the free range, not the 0.39 that would merely
have rescued beat 1.** Reasoning in `docs/DECISIONS.md`; the deviation from §4.1's published SQL
in `docs/SPEC-DELTA.md`.

**Beat 1 therefore fires as of 2026-08-12** — its seeded finding sits 0.3801 from the query it
embeds, which is now inside the cutoff. Nothing in `src/demo/scenario.ts` was changed to achieve
that. **Not yet confirmed on the hosted demo:** the new constant is in the Lambda bundle but the
CDK deploy has not run, so https://d11xbslgdgomdp.cloudfront.net still serves beat 1 at 0.35
until `npx cdk deploy` does.

**The lesson from this unit, for whoever writes SPA copy:** the demo deduped against its own
seed on the first hosted run, because the seed statement sat 0.2969 from agent-2's — inside
the dedupe threshold — so beat 4 never fired. Unit tests could not catch it; they control
distances by construction. Any new statement added to `SCRIPT` must be measured against the
others under Titan, and the measured distances belong in the comment beside it.
**Verify live first:** the four beats end to end against the deployed stack, in the
order `07` §3 gives them. Beat 4 is consolidation arriving over the change stream, and
`03` §4.4 is **not built** — see the note under U12. Either this unit builds enough
consolidation to make beat 4 true, or beat 4 is cut and `07` §3 is corrected. Do not
animate a beat the system does not perform: rule A7 requires the project to function as
depicted.
**Silent break:** a credential field. `02` B3 and `05` §5 forbid one *anywhere* in the
UI — under any name, on any path, behind an advanced panel, commented out, or feature
flagged off. That is invariant 8, and the SPA is the surface it was written about.
**Second silent break:** the show-SQL panel printing SQL the system did not run. It is
the "prove it" panel; a hand-written sample there is worse than no panel.

### U17 — Guardrails and all four degradation rungs ⬜ **also owns LIVE reasoning now**
**Added 2026-08-12, Julian's call.** U16b §3c proposed giving each demo agent one real
Bedrock call. It is deferred here rather than built there, because its prerequisite *is* this
unit's work: `04` §5 brake 2 — a global run counter in CockroachDB, default 40 LIVE runs a day
— is what authorises a LIVE run at all, and rung 1 (quota exhausted → REPLAY, stated on
screen) is the same mechanism seen from the other end. Building the counter inside U16b would
have meant U16b deciding U17's ladder.
Two things this unit inherits with it:
- **The counter needs a table `03` §2 does not define**, so adding it is a schema decision
  taken deliberately here. It must be checked and incremented **in the same transaction as
  the run it authorises**, or concurrent visitors race past it.
- **The Bedrock rate for Sonnet 4.5 is TBD.** `04` §5 and U16b §6 both require the real
  per-token figure written down before LIVE is enabled; two fetches of AWS's pricing page did
  not return it (V30) and this repository does not write placeholder numbers. The token
  volume *is* known from the committed cassettes: ~501 input and ~72 output tokens per call,
  so five agents is on the order of 3k tokens per run.
- `07` §4's mode line becomes a real two-value mode at that point, which closes the
  `docs/SPEC-DELTA.md` entry about it. `bench/reason.ts` is the reasoner to reuse — do not
  write a second one — and Sonnet 4.5 is pre-4.6, so `output_config.effort` **errors** on it
  and `thinking` must be omitted rather than configured.

**Done when:** "each rung forced deliberately and each produces a working page; each
brake fired deliberately and the demo stayed reachable; no credential field anywhere in
the UI; demo loads in a private window on a machine that never touched the project."
*(08 §5, 44–47h, verbatim)*
**Specs:** `04` §5, `05` §5, `02` §B
**Verify live first:** **rung 2 is reachable in REPLAY**, not only in LIVE — `04` §5 says
so explicitly and calls it the rung most likely to fire unnoticed, because REPLAY caches
reasoning but not embeddings. Force that one first; it is the one that will be assumed
safe.
**Silent break:** a brake scoped wider than the LIVE reasoning function. `04` §5 is
explicit that a budget action disabling the API, the SPA, the read path or the cluster
converts a cost control into a **rules violation**, because B4 requires availability
until 2026-09-15. Fire each brake deliberately and confirm the demo stayed up.
**Carry V22's finding in, and note it hardened twice on 2026-08-11:** at 10 account-wide
Lambda concurrency a `503` is reachable by ten simultaneous visitors, and a `503` is an
error page, which rung invariant 1 forbids. The increase **cannot be requested from the
CLI** — it is an account restriction below AWS's default, Service Quotas refuses every
useful value, and the Support API needs a paid plan. A console case is the only route and
its turnaround is unknown. **So this is no longer "absorb overflow or rely on the
increase". It is: absorb overflow. Build for 10 and treat any lift as a bonus.**
**And `04` §5's brake 1 is not available to you (V26).** Reserved concurrency cannot be
set on this account at *any* value — the unreserved floor is 10 and the ceiling is also 10
— so the pool cannot be subdivided either, and the LIVE function cannot be given a
physical cap of 2 the way §5 assumes. U14 deliberately substituted nothing.
**This unit picks the replacement**, and §5 constrains the choice hard: whatever it is, it
must target the LIVE reasoning function and nothing else, because a brake that disables
the API, the SPA, the read path or the cluster is a rules violation under B4. API Gateway
route-level throttling is the obvious candidate and has not been evaluated.
A fifth rung is the likely shape — concurrency exhausted → a queued or cached page that
says so — and it must not be an error status, per invariant 1.
**The last clause of the done-when is a separate act:** a private window, on a machine
that never touched this project. Not localhost, not a logged-in browser.

### U2 — `cortex init` ⬜ *(deferred from day one; see its entry above for why)*
**Done when:** "`cortex init` produces a working cluster twice in a row." *(08 §3, verbatim)*
**Specs:** `05` §2, `03` §2
**Verify live first:** that `ccloud` can provision, and that a second run is a no-op.
**Silent break:** printing a credential. `05` §2: no command may print one, and `doctor`
must fail loudly if a DSN appears in a tracked file.
**Placed here, before U18, on purpose.** `08` §6 does **not** list it as cuttable, so it
comes before SPA polish rather than after; and `docs/SPEC-DELTA.md`'s "`cortex bench` vs
`npm run bench`" entry closes when this lands, which the README then has to publish
correctly. A README documenting a command that does not exist is worse than a README
documenting a differently-named one.

### U18 — README, architecture diagram, licence, third-party disclosure ⬜
**Done when:** "a clean clone reproduces the benchmark." *(08 §5, 47–52h, verbatim)*
**Specs:** `09` §1, `07` §7, `02` §B
**Verify live first:** the clean clone itself — clone to a fresh directory and run the
published command. `bench/results/*/summary.md` already claims everything except
re-running needs no prerequisites; that claim is either true from an empty directory or
it is not, and only trying it settles which.
**Silent break:** a licence that GitHub's About section does not detect. `02` B2 asks
for **detectable and visible**, which is a repo-settings act as well as a `LICENSE` file.
**Diagram:** `02` B12 calls it free marks on Technological Implementation. It must show
the read plane as `cortex_reader` — the managed MCP server is not the route (V17).

### U19 — Video, recorded in LIVE mode ⬜
**Done when:** "uploaded, public, captioned." *(08 §5, 52–58h, verbatim)*
**Specs:** `07` §5, `02` §B
**Verify live first:** `npm run probe:reason` immediately before the session. V18 proved
entitlement on 2026-08-10, and entitlement is an account fact that can change without
this repository knowing. **`psql` is installed as of 2026-08-11 (V25)** and reads real
memory as `cortex_reader` — but Homebrew's `libpq` is keg-only, so the take needs
`export PATH="/opt/homebrew/opt/libpq/bin:$PATH"` first or `psql` is simply not found.
**Silent break:** B9 — a third-party trademark in frame. Agent-vendor logos, tool
branding in the terminal, or music that is not self-produced. Capture in scripted-agent
mode, which `08` §7 names as the mitigation for both this and inconsistent behaviour.
**Second silent break:** narrating a capability the footage does not show. B7 requires
the video to show the project **functioning**, and A7 requires it to function as depicted.

**Takes to capture, carried forward from the previous version of this section:**
- **An unmodified third-party agent attaching to `npm run serve`**, listing the three
  tools, and proposing. The whole prompt-surface argument in `05` §3 is that no bespoke
  client is needed, and that is far more convincing seen than described. The verification
  log already carries a granted / blocked / deduped transcript from a client with no MCP
  SDK — the text is the proof, the agent is the demo.
- **The two-terminal contention gate** (U6), reproducible on demand via
  `npm run gate:contend`. No take recorded yet.
- **An agent recalling with `psql` and nothing else** — the skill's SQL pasted into a
  standard client against `CORTEX_READER_DSN`, returning rows.
- **`npm run bench` printing both arms side by side**, with `live model calls embed 0,
  reason 0` visible on each. Run it twice in the take so the figures repeat: the
  determinism is the point and a still frame cannot show it. The CORTEX arm takes ~45s
  of real time against the cluster; cut or speed it.
- **`curl` against the hosted API route returning the cluster's own version string**
  (new, from V22). Five seconds, and it is the shortest demonstration that the hosted
  surface talks to a real CockroachDB cluster. Since U14 it answers as `cortex_demo`,
  which makes the same take also show the least-privileged principal serving the public
  route: `curl -s https://clotk5952m.execute-api.us-east-1.amazonaws.com/identity`.
- **`npm run gate:stream`** (new, from V26). Four lines of PASS and then the actual JSON
  the browser received. It is the whole of `04` §2's flow E in one command — a row
  committed as `cortex_demo`, carried by CockroachDB's own changefeed, arriving on a
  socket in ~126ms — and it is far more convincing than the architecture diagram it
  corresponds to. Run it after `npm run changefeed status` shows a running job.
- **A credential-shaped field being refused by the hosted API**, in one `curl`:
  `-d '{"dsn":"postgresql://u:p@h/db"}'` comes back 400 with the reason. `02` B3 is a
  rule most submissions can only assert; this shows it being enforced.

### U20 — Devpost description, B10 and B11 answers, feedback field ⬜
**Done when:** "walk the checklist in `02` §F." *(08 §5, 58–60h, verbatim)*
**Specs:** `07` §6, `02` §C, `02` §D
**Verify live first:** re-fetch the rules and diff them. `08` §7 lists "rules amended" as
low-likelihood and high-impact with exactly that response, and `02` §F is dated 2026-08-17.
**Silent break:** shipping `02` §C's answer text as written. Three of its four items still
describe the managed MCP server as the agent's read path, which V17 falsified. **B10 asks
what the agent actually did**, so an answer describing a route the project abandoned is a
false statement to a judge, not a stale doc.
**The feedback field (B13) is not optional in practice.** `08` §5 and `02` B13 both say
almost nobody fills it. `docs/verification-log.md` is written to be that answer.

---

## Cut list — `08` §6, verbatim

Copied here so a future session under time pressure drops the right things rather than
improvising. Ranked by what to abandon first: cutting from the top costs almost nothing,
cutting from the bottom costs the submission.

1. Time-travel panel
2. OpenTelemetry export
3. `cortex run` process wrapper, keep `serve`
4. Glob expansion beyond a fixed depth
5. Threshold sweep, publish a single value and say it was not tuned
6. Heartbeat and lease extension, use a longer fixed lease
7. Live mode entirely, ship replay only and record the video locally. This does not
   endanger rule B4: a replay-only demo is still a working project available free and
   without restriction, because REPLAY runs fully live database behaviour. What would
   endanger B4 is shipping LIVE without its degradation rung
8. **Never cut:** the arbitration transaction, the benchmark, the naive toggle, the
   README first screen, the video, and anonymous zero-setup access to the demo

Two notes on this list as it stands today, neither of which changes its order:

- **Items 3, 4 and 6 are already banked.** Heartbeat was decided against at U9, glob
  expansion is bounded by `CORTEX_REPO_ROOT`, and there is no `cortex run`.
- **Item 5 has already been paid for.** The sweep exists and is committed
  (`bench/results/*/threshold-sweep.md`), so cutting it now saves nothing. What it bought
  is a published value with a measurement behind it instead of an untuned one.
