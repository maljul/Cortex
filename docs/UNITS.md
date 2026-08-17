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

### U2 — `cortex init` ✅ 2026-08-16 *(deferred from day one; the deferral reasoning is kept below)*
**Done when:** "`cortex init` produces a working cluster twice in a row." *(08 §3, 2–5h, verbatim)*

**Closed by running it twice against the live cluster**, both exit 0, the second creating
nothing, appending nothing and re-verifying everything. `bin/cortex.mjs`, `src/cli/`,
`test/cli-init.test.ts` — 45 tests, 166s against the real cluster.

**Provisioning-optional, and it does not pretend otherwise.** `ccloud` is not installed here, so
`init` takes an existing operator DSN and brings a cluster from empty to working rather than
claiming to create one. Roles are **derived by parsing `sql/001_init.sql`**, not hardcoded, so a
fourth role added to the migration cannot escape it. Verification **attempts statements** and
never reads a catalogue — V9's lesson. Nothing is ever rotated, which is what makes the second
run safe.

**Three things the brief asserted that measurement falsified.** `scripts/sql.mts` cannot be
imported (everything below `process.argv.slice(2)` runs at module scope), so `splitStatements` is
copied and **pinned byte-for-byte** by a test, the `RECALL_SQL` device again; the permanent fix is
an entrypoint guard in `sql.mts`, after which the copy goes. `tsx` was **not** moved to
`dependencies` — the lockfile's root entry mirrors `package.json` and `npm ci` compares them, so
moving it would desync the clean-clone path U18 verified. And the first draft turned the mechanical
gate's `sql-containment` row **red**; fixed rather than evaded, by moving every statement the CLI
sends into `src/cli/statements.sql` selected by name, which satisfies `04` §1 more completely than
the grep asks.

**`bench` is deliberately not a subcommand** — `cortex bench` exits 1 naming `npm run bench`,
because a subcommand that silently does nothing is worse than one that does not exist.
`docs/SPEC-DELTA.md`'s entry is corrected in place rather than ticked closed.

**The no-credential test asserts a negative, so the predicate was proved to fire first:** on
simulated leaked output it catches 12/12 values and 4/4 DSN passwords, with no false positive on
clean output. No credential-shaped literal is written into the test — the positive case is fed the
gate script's own declared placeholders at run time.

The cluster was left exactly as found: no leftover probe roles, no leftover rows, `.env`
byte-identical.

---

*The deferral reasoning, kept because it explains why this sat at the bottom of the list for a
week and because the rule at the top of this file points here:*
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

Order of work, **as revised 2026-08-12**:
**U14 → U15 → U16 → U17 (partial) → U21 → U22 → U23 → U24 → U25 → U26 → U18 → U19 → U20 → U2.**

`docs/superpowers/specs/2026-08-12-fleet-demo-design.md` §11 displaces the previous order
(`U17 → U2 → U18 → U19 → U20`) and adds U21–U26. Julian's call on 2026-08-12, taken after
U17's brake 2 and rung 2 were already built and committed.

**U17 is not cancelled and not finished.** Two of its pieces are banked (below) and the rest
is displaced rather than dropped: rung 1 is reassigned to U24, which owns LIVE; rung 3's
mechanism is `DEMO_SESSION_ROW_CAP`, which the design's §4.1 turns into two budgets per
visitor, so building it now would be building it twice. Rung 4, the brake 1 replacement and
brake 3 survive the redesign untouched and are picked up after U26 unless U24 subsumes them
— design §7.2 says a global LIVE run counter may already be the brake 1 replacement, and
that is a question to answer at U24 rather than assume here.

**U2 slips behind all of it** (design §11).

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

### U16 — Demo SPA: three panels, naive toggle, show-SQL ✅ 2026-08-12
**Done when:** "the four beats read clearly to someone who has not seen it."
*(08 §5, 38–44h, verbatim)*

**Closed 2026-08-12 by the only act that could close it: Julian opened the deployed page
and confirmed the four beats land.** No test and no driven read could substitute — V32 was
a *driven* read, taken with `docs/UNITS.md` already in hand, so it could confirm the
mechanics and not the done-when. The done-when says "someone who has not seen it", and that
sentence is answered by a person or not at all.
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

**The cold read happened and the beats land.** That was the whole of the remainder. The
honest failure mode this unit carried — a page that is correct and unreadable — did not
occur, and it could only ever have been ruled out this way.

**Four defects found by looking, none of which a test would have caught — all four now fixed
and deployed.** (1) Beat 1's `NOTHING KNOWN` carried no explanation in the cortex arm while the
*naive* arm's identical badge carried one; closed by the threshold decision rather than by copy,
since the beat now fires. (2) The show-SQL button's sub-label did not toggle with its label.
(3) `CLAIM P50` naive stays `—` where every other row has both sides — kept, because `—` is the
published benchmark's own convention for "this arm has no such thing to measure", but the meter
now says so. (4) V35: `RECALLED` rendered as a badge with no finding and no revert.

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

**Beat 1 fires, confirmed on the hosted demo in a browser (V35).** Its seeded finding sits
0.3801 from the query it embeds, which is now inside the cutoff. Nothing in
`src/demo/scenario.ts` was changed to achieve it — `npx cdk deploy` updated `DemoFn` and the
beat came alive.

**Rendering it exposed a fourth defect, and it is fixed.** `RECALLED` was a badge with **no
payload**: `renderFleet` handled `detail.contested` and `detail.of` but had no branch for
`detail.findings`, so beat 1 showed a verdict while every other card showed its story. The
branch had been unreachable for as long as it existed — at 0.35 recall returned zero rows, so
the case never rendered — which is why no test caught it and a browser did. The card now carries
the finding and, crucially, `— a prior attempt was reverted`, because `RECALL_SQL` orders by
`times_reverted DESC` ahead of distance and that ordering is the whole claim.

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

### U17 — Guardrails and all four degradation rungs 🔶 **ladder built and forced 36/36; the private-window clause is U26's**

**The ladder is closed (2026-08-16 into the small hours of 08-17 — commits `fbca43f`,
`ec9e15b`, `0ded856`).**
`npm run gate:ladder` forces **all four rungs, a rung 1b, and all three brakes: 36/36**.
`npm run gate:degrade` is an alias for the same script — one gate under two names, because the
name it was built under is cited across this file and moving it would break every citation.
The only part of this unit's done-when still open is its last clause, a private window on a
machine that never touched the project, which is Julian's act and belongs with U26's cold read.

**Where it started (2026-08-12, V36 + V37).** Both of the things this unit was blocked on
closed here, and the two pieces that did not depend on LIVE reasoning were built and forced.

- **Brake 2 is built: `live_run_budget`, a seventh table, one row per UTC day.**
  Julian's call on where the counter lives (a new table with its own narrow policy, not a
  singleton row on `repos` and not DynamoDB). Reasoning in `docs/DECISIONS.md`. The cap it
  enforces was a literal `10` when it was written and is **derived in code** since U24 —
  `LIVE_RUNS_PER_DAY` is computed from a metered run, and comes out at 30.
  `cortex_demo` reaches exactly today's row and holds no DELETE — a principal that can drop
  today's row can reset the brake that governs it. `test/privilege-planes.test.ts` attempts
  all three refusals rather than trusting the grant list.
- **The Bedrock rate is no longer TBD, and it did not come from a pricing page.** AWS's
  machine-readable Price List API does not carry Sonnet 4.5 at all — its Claude catalogue for
  `us-east-1` stops at Claude 3. The rate came from this account's own billing:
  `Claude Sonnet 4.5 (Amazon Bedrock Edition)` is a **service of its own**, separate from
  `Amazon Bedrock`, at **$3.30 per 1M input and $16.50 per 1M output**. V36 has the commands.
- **`04` §5's own default of 40 runs a day breaks `04` §5's own budget**, and that is why the
  cap is not §5's. At the measured rate and U24's metered run, 40 a day across the judging
  window is over **$360** against §5's "single-digit dollars". The replacement was a literal
  10 written here; U24 replaced it with a derived 30. Recorded in `docs/SPEC-DELTA.md`.
- **A finding brake 3 depends on:** an AWS Budget filtered on the `Amazon Bedrock` service
  would **never fire**, because the reasoning spend is billed under a different service name
  entirely. `Amazon Bedrock` on the same days carries only the Titan embedding line. Brake 3
  was built on that finding — see the bullet below.
- **Rung 2 is built and forced — 7/7 on its own when it was written (V37), and now one section
  of `npm run gate:ladder`'s 36.** Every embedding call
  refused with a 429; all four beats still ran, 51 statements reached the driver, every intent
  written was marked in the database, and the show-SQL transcript contains no similarity
  search at all. Forced first because §5 names it the rung most likely to fire unnoticed.
  It needed a `03` §2 column (`intents.embedding_degraded`) — see `docs/SPEC-DELTA.md`; the
  column is not primarily a UI flag, it is what keeps a hash vector out of every later dedupe
  candidate set.

**The rest of this unit was displaced, not dropped — Julian's call on 2026-08-12** after
`docs/superpowers/specs/2026-08-12-fleet-demo-design.md` landed mid-unit. Where each piece went,
and **all of it landed with U24 on 2026-08-16, before U26 rather than after it**:

- **Rung 1** (LIVE quota exhausted → REPLAY, stated on screen) → **U24**, which owns LIVE. It
  needed LIVE reasoning to have something to exhaust, and §11 reassigned LIVE there. Built and
  forced, together with a **rung 1b** the ladder adds: the `bedrock:InvokeModel` grant refused at
  runtime, which is the shape brake 3 produces when it fires. The fleet still completes; the
  model author falls back to reviewed patches on AccessDenied like any other failure.
- **Rung 3** → **U24/U25's state route.** Its mechanism is `DEMO_SESSION_ROW_CAP`, and design
  §4.1 gives each visitor **two** scopes and therefore two budgets. Built, and forced by filling
  a session's row budget and then asserting the session is still inspectable and a new one is
  still one click.
- **Rung 4** (cluster unavailable → pre-recorded walkthrough behind an explicit banner) is built
  and forced by pointing the demo plane's DSN at an unreachable write path.
- **Brake 3** is built and armed (`ec9e15b`): an **ANNUAL** $9 cost budget named
  `cortex-live-reasoning`, filtered on `Claude Haiku 4.5 (Amazon Bedrock Edition)` and
  `Claude Sonnet 4.5 (Amazon Bedrock Edition)` — the two service names
  `aws ce get-dimension-values --dimension SERVICE` actually returns, not `Amazon Bedrock` —
  whose action attaches a Deny on `bedrock:InvokeModel` to the fleet runner's role and to nothing
  else. **Annual, not monthly**, because the judging window spans two calendar months and a $9
  monthly budget permits $9 in August and $9 again in September.
- **The brake 1 replacement** is settled, and the paragraph further down that used to name a
  candidate now names the answer.
- **The last clause of the done-when** — a private window on a machine that never touched the
  project — is Julian's act, not a script's, and it belongs with U26's cold read. It is the only
  part of this unit still open.

**Added 2026-08-12, Julian's call.** U16b §3c proposed giving each demo agent one real
Bedrock call. It is deferred here rather than built there, because its prerequisite *is* this
unit's work: `04` §5 brake 2 — a global run counter in CockroachDB, default 40 LIVE runs a day
— is what authorises a LIVE run at all, and rung 1 (quota exhausted → REPLAY, stated on
screen) is the same mechanism seen from the other end. Building the counter inside U16b would
have meant U16b deciding U17's ladder.
What this unit inherited with it, and where each landed — all three are resolved:
- **The counter needs a table `03` §2 does not define**, so adding it was a schema decision
  taken deliberately here. It asked for the check and the increment to be **in the same
  transaction as the run it authorises**, or concurrent visitors race past it. The race is
  closed and the shared transaction is not what closes it: a demo run is deliberately *many*
  transactions, several of them concurrent with each other, so there is no single one to join.
  **SERIALIZABLE is the brake** — measured in `src/memory/live-budget.ts`, where ten concurrent
  callers against a cap of three get exactly three slots even when the cap is moved out of the
  statement into a branch. A slot is spent when it is granted rather than when the run succeeds,
  which is the safe direction.
- **The Bedrock rate for Sonnet 4.5 was TBD, and V36 measured it** — $3.30 per 1M input,
  $16.50 per 1M output, from this account's own billing after two fetches of AWS's pricing page
  failed (V30) and its Price List API turned out not to carry the model at all. The cassette
  token volume this bullet used to reason from — ~501 input and ~72 output tokens per call —
  described the old five-agent scenario and is superseded by U24's metered fleet run.
- **`07` §4's mode line is a real two-value mode now**, and the page derives it per run rather
  than appending a fixed sentence (U25, `6096bd3`). `bench/reason.ts` remains the reasoner for
  the benchmark — do not write a second one — and Sonnet 4.5 is pre-4.6, so
  `output_config.effort` **errors** on it and `thinking` must be omitted rather than configured.
  The fleet runs Haiku 4.5, which is a separate grant and a separate ARN.

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
**This unit deferred picking the replacement to U24, and U24 settled it** — the reasoning is
in `scripts/gate-ladder.mts` above the check that asserts it. §5 constrains the choice hard:
whatever it is must target the LIVE reasoning function and nothing else, because a brake that
disables the API, the SPA, the read path or the cluster is a rules violation under B4. The
answer is that brake 1's *intent* is met by three things that now exist, none of them a
concurrency reservation:
- the **global LIVE run counter**, which bounds *spend* and touches nothing else. Past the cap
  a visitor gets a REPLAY run and a sentence saying why; the database, the API, the SPA and the
  read path are untouched, which is exactly what B4 requires of a cost control.
- the account's own **10-slot concurrency ceiling**, which bounds *fan-out* — the physical
  property §5 wanted brake 1 for — by accident of the very restriction that falsified brake 1.
- **`LiveReasoningPolicy`**, a managed policy in `infra/cdk/` attached to the fleet runner's
  role and to nothing else, whose detachment stops model calls and stops nothing else.
API Gateway route-level throttling was the obvious candidate and was not needed. **No fifth
rung was added**: rung 1b forces the runtime shape of the third of those, and what a visitor
gets is a completed run authored from reviewed patches, not an error status.
**The last clause of the done-when is a separate act:** a private window, on a machine
that never touched this project. Not localhost, not a logged-in browser.

---

## The fleet demo — U21 to U26

Added 2026-08-12 from `docs/superpowers/specs/2026-08-12-fleet-demo-design.md` §11, which is
the design of record for this run and carries the reasoning behind every decision below. Each
done-when is **verbatim from §11's table**. The design says each unit gets "the four things
`/go` STEP 0 needs, including a named silent break, when it is written into `docs/UNITS.md`";
this is that.

**What this replaces.** `POST /demo/run`'s four scripted beats become a real ten-task workload
run across two arms, streamed rather than blocking, on a rebuilt page. Design decision 7 is
that the change is **additive and the current deployed page keeps serving** until U26's cold
read passes, so nothing here can cost the submission.

**What it must not touch** (design §1): the memory model, `src/db/retry.ts`, row-level
security and `cortex_demo`'s confinement, the privilege planes, the published benchmark and
its committed results directory, `bench/cassettes/` as the reproducibility claim, and
invariant 8.

### U21 — Workload runner: curated cut, five agents, fair naive lane, two scopes ✅ 2026-08-13
**Done when:** "ten tasks run to completion in both arms against the real cluster, all four
beats observed." *(design §11, verbatim)*
**Specs:** `06` §2, `06` §4, `03` §4.2 — plus design §3 and §4, which are the shape.

**Closed by `npm run gate:workload`, 17/17, V50.** Eleven tickets, two scopes, both arms,
all four beats observed rather than scripted — and four of the five interlocks produced their
defect on the run.

**Two of its checks are race-dependent and a run can legitimately come back 15/17 (V51,
2026-08-13).** A pre-change baseline on an unmodified tree failed `every loss is attributable —
P6b` and `interlock 4 — naive implemented the confirmation twice`; the run immediately after U22
was 17/17. Both failures are one event: the naive lane's two-transaction dedupe sometimes *catches*
the racing P6 pair, so the second half never does the work, interlock 4 does not happen, and its
absent hunk is reported as a loss with nobody to attribute it to. That is the window design §4.2
describes — "the dedupe passes against a snapshot that was true a moment ago" — being narrow rather
than absent. **Re-run before concluding anything from a red gate**, and do not treat a 15/17 as a
regression without a second run. `src/demo/workload.ts` is the runner, `src/memory/naive-lane.ts` the
conventional stack it is compared against, `bench/demo-app/` the fourteen-file corpus,
`bench/demo-workload.ts` the cut with its patches. Tests: `test/workload.test.ts` (10),
`test/naive-lane.test.ts` (5), `test/demo-workload.test.ts` (17), plus `test/patches.test.ts`
and `test/app-bundle.test.ts` rewritten for the new corpus.

**Verify live first:** (a) the Titan distance between **every pair** of statements in the
curated cut — **DONE, V38**; (b) the row count of a ten-task cortex run against
`DEMO_SESSION_ROW_CAP` — **DONE, V50: 24 rows in the cortex scope and 32 in the naive one
against a cap of 200.** Roughly eight times the headroom needed; the cap does not move. (c)
**Added and it changed the design: whether recall can carry a decision across a module boundary
at all — V49.** Interlock 1 reaches on the mechanism's own fallback (0.4323); interlock 2 did
not reach in any ordinary phrasing (0.8459, 0.7183, 0.6544) and would have merged cleanly and
silently not happened. The repair is V39's finding a second time — a note naming the work it
endangers reaches at 0.3633 where a note naming the change does not. **No threshold moved.**

**Two silent breaks the run found and no test could have** (V50), both now assertions about
`ASSIGNMENT` in `test/workload.test.ts`:
- **A sequenced dedupe pair is deduplicated by the naive lane too** — its search is the same
  statement against the same rows and works fine against an intent that committed a second ago.
  U16b's "beat 2 is a sequence" precedent does not transfer, because U16b's naive arm had no
  dedupe. The window design §4.2 describes exists only under concurrency, so the pairs race.
- **An intent that never closes stays a dedupe candidate for ever** — the naive lane was built
  not to close, so A1 stayed `in_flight` and deduplicated the eleventh ticket at 0.3686 against
  a task that had been *given up on*. It now closes, and the findings the sink writes into its
  scope are simply never read. Reasoning in `docs/DECISIONS.md`.

**Julian's call, 2026-08-13: the naive lane's lock locks the ticket, not the file.** Locking
files and honouring them serialises the contended trio and deletes interlock 3; locking files
and ignoring them reads as a strawman. A job lock is what that stack actually takes and is
exactly what cannot see two tickets colliding in one file. `docs/SPEC-DELTA.md` carries it.

**The cut is chosen and it is `P6a P6b P2a P2b C1 C2 C3 I3 R3 A1`** (V38, `npm run
measure:statements`). Design §3's slices exactly. The measured numbers, which belong beside
the statements when they are written into code:

- `P6a/P6b` **0.0610** and `P2a/P2b` **0.2058** — the two dedupe pairs, chosen on margin.
  P6's halves touch *different* files so dedupe fires with no claim overlap; P2's share one.
- **P3 was rejected at 0.3630** — 0.0270 inside the threshold, on the exact lower edge of the
  dedupe sweep's perfect band, too thin to hang a demo on. P1 (0.3203) is the reserve.
- `I3/R3` **0.4293** — outside dedupe by 0.0393 and inside recall by 0.1707. **The recall pair
  only works because the two thresholds differ**, which is V34's ordering argument showing up
  as a task pair.
- The seed statement is **0.7372** from its nearest cut member and carries forward unchanged.
- 6/6 declared pairs fire; **0 undeclared collisions** across all 253 measured pairs.
**The agents build a working app, and both versions run side by side on the page (Julian,
2026-08-13).** The tasks become real features rather than library edits, the agents' output is
a **small orders dashboard that renders in a browser**, and the demo shows **both final apps
live in iframes** next to the journey and the meter. Reasoning in `docs/DECISIONS.md`.

The corpus is new and demo-owned: **`bench/demo-app/`** — **built, fourteen files across seven
modules** (`lib`, `inventory`, `orders`, `shipping`, `notify`, `payments`, `web`), deliberately
layered so "which file does this ticket touch" has a non-obvious answer and the interlocks above
have room to cross a boundary. Plain scripts in a dependency load order, no imports and no
network, so `assembleApp` can hand a whole tree to an `iframe` via `srcdoc`; and **no input
element anywhere**, so there is no field on the demo surface for invariant 8 to be argued about.
`bench/fixtures/` and `bench/tasks.json` are untouched, so `08` §4's passed gate is unaffected.

**The domain stays orders, and that is not aesthetic.** V38 measured 253 pairwise Titan
distances to pick these eleven tickets. Changing the domain voids every one of them. An orders
dashboard keeps each statement usable as written, so only the patch bodies are new work.

**The ticket → visible feature map is the design, and it is now an interlock map**
(Julian, 2026-08-13: "they are fixing fairly complex on purpose", and the defects must live in
different parts of the code). Design §3.1 is the full version. Each defect is engineered so a
worktree-isolated agent fixes it **correctly in its own branch**, the branch passes, the merge
is **clean**, and the app is still broken — because the contradiction is *across* modules,
which is exactly what file-level isolation cannot see:

| # | Interlock | Modules it spans | Naive pane shows |
| --- | --- | --- | --- |
| 1 | **I3 → R3** money representation | `lib/money` → `shipping/quote` → `web` | shipping line **100× off**, totals disagree |
| 2 | **P2 → C3** stale cache defeats the guard | `inventory/repository` → `orders/create` | the oversell guard is present and **lets one through** |
| 3 | **C1 · C2 · C3** three features, one file | `orders/{list,status,create}` → `orders/repository` | pager, timeline or oversell refusal **silently missing** |
| 4 | **P6a ‖ P6b** same work, two modules | `notify/email` ‖ `notify/templates` | confirmation banner renders **twice** |
| 5 | **A1 → T11** abandonment recall | `payments/provider` → the spared agent | an agent burns the same dead end twice |

Interlock 1 rides the existing recall pair — R3 is only correct if it knows what I3 decided,
and nothing carries that across in the naive lane. **Interlock 2 is the sharpest**: P2 and C3
are different tickets in different modules and *neither agent is wrong* — the cache is correct,
the guard is correct, and together they oversell. Interlock 4 is the isolation proof in one
line: two files, no conflict, clean merge, duplicated work.

**Interlock 2 was a dead beat until V49 measured it, and the repair is the finding.** What P2's
agent would naturally write down — a cache was added — sits **0.8459** from the task the cache
endangers, and recall reaches 0.60; two further ordinary phrasings measured 0.7183 and 0.6544. A
note naming **the work the change endangers** rather than the change reaches at **0.3633**, which
is V39's abandonment finding arriving a second time from a different direction. That note is
**authored**, so `07` §4's honesty rule extends to it exactly as it extends to the patches: the
page must say the closure notes are authored, and must not claim consolidation *derived* the
warning. Interlock 1 carries no such caveat — its finding is `03` §4.4's own fallback, 0.4323 from
R3, with nothing written to make the beat fire.

**Four of the five are verified by executing the composed app** (`test/demo-workload.test.ts`),
which is design §12 item 8's requirement rather than a nicety: the naive lane renders a £3.37
quote as £0.03, oversells with the guard present and stock at −1, keeps one of three behaviours in
the shared file, and renders the confirmation banner twice, identically. Interlock 5 has no file
difference at all and shows in the journey.

**None of this touches a task statement.** V38's 253 measurements are what make the pairs fire;
rewording any statement or moving the domain off orders voids all of them. What changed is the
patch bodies and which files they touch, which is free.

**The naive lane is labelled as worktree isolation**, because a 30-day sweep (2026-08-13) found
that is uniformly what the field ships — MindFlock, Shikigami, Rabbitty, PraisonAI's "git
worktree workspace isolation primitive", makaio-framework's worktree pollution guards. Every one
frames its win as *not clobbering*; not one arbitrates intent. Beating the mechanism a judge
already believes in is what makes this a result rather than a strawman.

**The patch machinery transfers unchanged** — `src/demo/patches.ts`, `bench/demo-workload.ts`'s
shape and `test/patches.test.ts` are all corpus-agnostic.

**Third silent break, and it is the sharp edge:** a broken app reads as *"they wrote a broken
app"* unless every missing feature is **attributable on screen** — the agent that reported it
done, its intent id, its patch, and the file where the change is not. Without that link the
naive lane is an assertion rather than evidence, and A7 is not satisfied by a page that is
merely correct.

**Half of that is now built and enforced, ahead of the runner (V41, 2026-08-13).** It was prose
here and nowhere else, which is the thing CLAUDE.md forbids — a doc asserting an invariant no
test checks. `src/demo/attribution.ts` produces one record per feature
(`{ feature, agent, intentId, patch, file, inCortex, inNaive }`) and `unattributableLosses`
refuses any feature present under arbitration and absent without it whose attribution is
incomplete: no agent, no intent id, or an intent id the run's own steps do not contain.
`test/attribution.test.ts` asserts it against the real C1/C2/C3 trees, 7 tests.
**What the runner owes it is fixed and small:** a `WorkStep` per task per arm —
`{ taskId, agent, intentId, reported }` — where `reported` distinguishes `done` from
`deduped`/`blocked`/`abandoned`/`contended`, because attributing a loss to an agent that never
claimed it is a false accusation that passes every null check.
**Still to build: the panel that renders these rows — U25's, now that the runner exists.** The
runner supplies what the guard needs (a `WorkStep` per ticket per arm) and `npm run gate:workload`
prints the rows it would render, so the requirement can no longer be lost by nobody implementing
it.

**And the interlock map narrows what this covers to one interlock of five — read this before
building the panel.** `attributeFeatures` marks a loss as `inCortex && !inNaive`, i.e. the patch
text present in one tree and absent from the other. The 2026-08-13 interlock decision makes the
naive lane **worktree isolation with clean merges**, so for four of the five interlocks *every
patch is present in both trees* and this module correctly reports **nothing**:

| # | Interlock | Naive symptom | Covered here |
| --- | --- | --- | --- |
| 3 | C1·C2·C3, one file | one feature silently missing | **yes** — a loss, fully attributed |
| 1 | I3 → R3, money representation | shipping line 100x off | no — both patches present |
| 2 | P2 → C3, stale cache | guard present, oversell happens | no — both patches present |
| 4 | P6a ‖ P6b, duplicated work | banner renders **twice** | no — a surplus, not an absence |
| 5 | A1 → T11, abandonment recall | an agent burns the same dead end | no — no file difference at all |

This is not a defect in the module; it is the module's scope, and interlock 3 is the case it was
built and mutation-tested against. What it means is that **A7's "attributable on screen" needs a
second axis** the design decision implies and no code yet has: not *"which feature is missing"*
but *"which two correct changes compose into a wrong behaviour, and who made each"*. Interlock 2
is the one Julian named as the keeper and it is the one this is blindest to — nothing missing,
nothing conflicting, composed result wrong.

**Whoever builds the panel must not present this module's output as complete attribution.** A
page showing zero unattributed losses across a run whose whole point is four clean-merge
interlocks would be truthfully reporting the wrong question.

**~~Fallback if the corpus is not ready~~ — not needed.** The corpus is built and both arms'
final trees assemble into running apps (V50). Kept as the record of what the escape hatch was.

**The patches are committed, not model-authored (Julian, 2026-08-13).** This is the
unit's biggest change since it was written, and it came from the right question — the deployed
page could only show verdicts and counters, because `bench/types.ts` defines an agent's output
as `Effect { file, startLine, endLine }`, **line numbers with no code**, and nothing anywhere
writes a file. So each demo task now carries a **small checked-in patch**. Agents read the real
fixture file, decide, claim through the one arbitration transaction, apply, and close — the
coordination is entirely live; only the code content is fixed. Reasoning in `docs/DECISIONS.md`.

What this buys, concretely: the naive lane's final `orders/repository.ts` is **missing two of
three changes that agents reported as done**, and the page can name exactly which hunks, because
the patches are known. The dedupe pair implements order-confirmation email **twice, in two
files**, while the CORTEX lane's second agent stands down for **0 tokens**.

**Honesty requirement:** the mode line must state the patches are authored, alongside its
existing statement about cached reasoning. `07` §4 forbids implying a model wrote committed code.

**Silent break:** **the fair naive lane's two transactions collapsing into one.** Design §4.2
makes the naive lane run the same dedupe search and the same claim in *separate* transactions
— that split is the entire thing being demonstrated, it is `01` §3's falsification test made
executable, and if a refactor ever wraps both in one `withRetry` the naive lane silently
becomes the cortex lane. Every row would still be valid and every test would still pass while
the demo showed no difference at all. The show-SQL panel is already grouped by transaction
(U16b), so the guard is a test asserting the naive lane produces **two** `BEGIN` blocks where
the cortex lane produces one.
**Second silent break:** a task statement reworded by ear. §3 records what this cost once — a
seed 0.2969 from agent-2's intent, inside the dedupe threshold, which deleted beat 4 without a
single test failing. `npm run measure:statements` is the check; run it after any rewording.
**And know which constraint applies to what** (V38): the seed's *fact* goes to `findings`,
which `findDuplicate` never reads, so it cannot dedupe anything at any distance — it must be
< 0.60 from R3 to be recalled and > 0.20 from R3's own outcome not to be merged. The seed's
*statement* becomes an intent at status `done` and **is** a dedupe candidate. The first version
of the measurement script applied the statement's rule to the fact and rejected two good
candidates.
**~~Note: re-recording cassettes is required~~ — not for this unit, and deliberately not.** The
runner makes **no model call at all**. Which variant of a patch an informed agent applies is
decided by comparing what `recall()` returned against what consolidation actually wrote, exactly —
so no cached model output sits in the causal path, and an undelivered changefeed leaves the agent
honestly uninformed. `07` §4's mode line therefore keeps its current wording rather than gaining
"reasoning is cached". Recorded in `docs/SPEC-DELTA.md`; cassettes become U24's if LIVE lands.

**An eleventh task is approved and must NOT go in `bench/tasks.json`** (Julian, 2026-08-12).
Design §1 and `08` §4's passed gate freeze that file at 30 tasks with committed results, so the
demo's curated cut becomes **its own file** referencing benchmark ids and adding this one.
Its purpose: A1 is abandoned as impossible, and this is the agent that gets spared — the moment
that shows what memory buys and a lock service cannot. Two mechanism changes were needed to make
it honest and both are built (V39): abandonment now consolidates, and an abandoned finding is
embedded on the work rather than the obstacle. Candidate wordings measured at **0.4698–0.4899**
from A1's finding (recalled) and **≥ 0.8342** from every live task in the cut (no accidental
dedupe). Pick one, re-measure it in place, and put the number in the comment.

### U22 — Async run and streamed events ✅ 2026-08-13
**Done when:** "`POST /demo/run` returns inside the gateway ceiling and the whole run arrives
over the socket." *(design §11, verbatim)*
**Specs:** `05` §5, `04` §2, `04` §5

**Closed by `npm run gate:async`, 13/13, V51** — against the deployed stack, which is the only
place a gateway ceiling exists. **482ms against a 30,000ms ceiling; 87 of 87 fleet events
delivered; exactly one terminal message and no runner message after it.** CockroachDB changefeed
rows are a separately-labelled source and may arrive after the runner has terminated; V56 caught
the gate incorrectly counting those rows as late runner output and narrowed the assertion to the
source whose ordering `streamRun` owns. `src/demo/run.ts` is the sink,
`infra/lambda/runner.ts` the second Lambda, `infra/lambda/fanout.ts` the one socket fan-out both
producers now share. Tests: `test/run-stream.test.ts` (7) and five live cases in
`test/demo-plane.test.ts`.

**The verify-first list falsified the design's own premise, and that is the unit's main finding.**
Design §5.1 says a two-arm run "will exceed API Gateway HTTP's integration ceiling (~30s)" and to
verify it first. Verified by deploying the runner **synchronously on purpose** to take the 504 —
and no 504 came: **202 in 7.36s**, the whole response measured at **4548ms**, the runner's own log
putting the two-arm run at **5943ms**. Deployed in-region a run is **6–9 seconds**, not the ~50s
the same run takes from a laptop; the gap is round-trip latency over ~350 statements per arm.
**Every wall-clock figure this repository publishes for the workload is a laptop-to-cloud number**
— U21's 28–42s and 19–25s included — and says nothing about what a visitor waits.

The shape stayed asynchronous and **every comment citing the ceiling was rewritten in place**, on
three reasons that survive the measurement: the stream *is* the demo (design §9 wants the collision
watched, not reported); U24's LIVE mode at ~50 model calls will exceed the ceiling on its own;
and `07` §1's ninety-second budget is not carriable on any response. `docs/SPEC-DELTA.md` and
`docs/DECISIONS.md` carry it.

**The route decision, and it was the unit's first act (`docs/DECISIONS.md`).** `POST /demo/run`
keeps its synchronous four-beat behaviour and takes the fleet run behind **`mode`** — `arm`'s twin,
two accepted values against a closed set, neither reaching SQL. A sixth route is refused by design
§8 in writing; breaking the route is U25's work pulled forward and moves the cut line. The beats
branch is deleted when U25's page lands, and the route keeps its name. `test/demo-plane.test.ts`
guards the default path **live**, because nothing else would notice its removal —
`test/scenario.test.ts` calls `runScenario` directly.

**`POST /demo/session` creates two scopes and `sessionId` is the cortex one**, not a third `repos`
row, so the deployed page reads the field it always read. `npm run gate:workload` now takes the
pair from `createDemoSessionPair` rather than assembling its own — while it assembled its own, the
route could have created one scope for ever and the gate would have passed.

**Pool headroom, §12 item 2: no two-wave fallback is needed and the page has nothing to disclose.**
`pg`'s pool max on the demo plane is exactly **10**, and ten overlapping transactions each holding
a 2s sleep all committed in **2497ms** — genuine concurrency, not queueing. The runner still runs
its arms **sequentially**, which is a measurement decision rather than a capacity one: concurrent
arms would have each arm's `claim_p50` and `serialization_retries` measured under the other's load.

**The named silent break has two paths and only one is a throw.** The other is the runner reaching
its Lambda timeout, which kills the process without running any `finally` — so `try/finally` covers
half the problem while looking like all of it. The watchdog is therefore in `streamRun`, where a
test forces it with a 60ms budget against a run that never settles; removing the race hangs that
test to vitest's 30s ceiling.

**And the sink had its own version of the same defect, found by re-reading it after the gate had
already passed.** The terminal message was published and the channel closed *afterwards*, so on the
watchdog path — where the run is still alive and still emitting — a late fleet event could land
behind it. **Two attempts to test that passed against it**, both the same mistake: a *synchronous*
`publish` drains in microtasks and shuts the window before a timer fires, and asserting the instant
`streamRun` resolves misses publishes that are queued but have not had their turn. The guard needs
an async publish **and** a wait after the return, because `streamRun` returning does not end the
process — the runner writes two transcripts afterwards. V51 has the mutation output.

**One thing this unit deliberately did not build:** the final trees are returned by `streamRun` and
**not** published on the socket. Design §8 serves the artifacts through `GET /demo/state`, and that
is U23's.

**Three things U25 inherits, and the first is a real gap rather than a note.**
- **A socket registers exactly one `session` query parameter, and a visitor now has two scopes.**
  The *runner* broadcasts a run's messages to both, so one socket sees the whole fleet journey —
  but `infra/lambda/changefeed.ts` matches a row's scope exactly, so **the naive lane's real rows
  do not reach a page subscribed to the cortex scope**. Measured on the gate: 43 changefeed rows
  arrived, all cortex. The page needs a second connection, or `$connect` needs to accept more than
  one session. Do not discover this while building the swimlanes.
- **The show-SQL transcript is per scope**, because `writeSqlLog` keys on the session id. The
  runner writes two entries, so the naive lane's `BEGIN` blocks are at
  `GET /demo/sql-log?session=<naive scope>` and the cortex lane's at the cortex one. Design §9
  wants them side by side, which is two fetches rather than one.
- **`infra/lambda/fanout.ts` has no unit test and deliberately so** — it is DynamoDB and API
  Gateway's management API and nothing else. `npm run gate:async` is its coverage, end to end
  against the deployed stack. If it grows a decision, that decision belongs in `src/demo/`.

**A blocker found by bundling rather than by reasoning.** `src/demo/patches.ts` reads the corpus off
disk through `import.meta.url`, which esbuild leaves **empty** under CommonJS — and the fourteen
files were not in the artifact at all. The runner would have deployed cleanly and thrown on the
first file the first agent read. `bench/demo-app/` is now copied next to the handler,
`CORTEX_CORPUS_ROOT` names it (the shape `CORTEX_REPO_ROOT` already set in U8), and `infra/bundle.mjs`
fails loudly if the copy is empty.
**Every agent step streams as it happens (Julian, 2026-08-13):** `started → reading → decided
→ claiming → patched | blocked | deduped`, per agent, over the existing socket. A judge watches
the collision happen rather than reading that it happened. Design §5.3's requirement stands —
changefeed rows and fleet events are **labelled differently**, because a fleet event carries no
primary key and nothing may imply it does.

**Silent break:** a run that dies after `POST /demo/run` has already returned 200. The visitor
gets a page that never finishes and never errors — invariant 1 satisfied to the letter and
broken in spirit. Every path through the runner must emit a terminal event, including the
paths that throw.
**Carry in:** this account's Lambda concurrency is 10, unraisable and indivisible (V22, V26).
Design §5.2 fixes one visitor's run at **2** invocations with the agents as async tasks inside
the runner; ten agents as ten Lambdas would consume the whole account for one visitor.
**~~Carry in~~ — FIXED the same day (V45), after the two authorised jobs closed and Julian
asked for it.** Kept here as the record of what it was. The demo API's credential refusal
scanned the request **body only**: `src/demo/api.ts:127` passes `request.body` to
`findCredentialField` and never `request.query`, while `infra/lambda/demo.ts:104-110` parses
every query parameter and hands it in. So `GET /demo/state?session=<valid>&dsn=…` returns
**200** on the deployed API — the field is ignored and the request honoured. `05` §5 says "on
any path", and `api.ts:40-44`'s own docstring states the rule this misses: *"ignoring it is not
enough, because the rule exists so that the field never appears to work."* To be exact: **no
credential field is declared on any surface**, so invariant 8 as CLAUDE.md words it survives —
what fails is "rejected rather than honoured" on the query string. The fix was two lines plus five
cases in `test/demo-plane.test.ts` — four refusals and one non-vacuity guard proving `session`
still gets through. **Deployed 2026-08-13 (V46)** together with `ChangefeedFn`'s pending
status-filter change from V39, and each proved on the deployed stack: the same `curl` returns
404 before and `400 {"field":"query.dsn"}` after.

### U23 — Measurement completeness: `conflicting_edits`, artifacts, both-arm meters ✅ 2026-08-13
**Done when:** "every rendered number has a test that fails if it is set from a literal."
*(design §11, verbatim)*
**Specs:** `06` §3, `07` §1, `07` §2
**Verify live first:** that `conflicting_edits` is genuinely computable — it needs real line
ranges from real patches, and it is the one `06` §3 metric the demo has never been able to
produce.

**DONE, 2026-08-13 (V51's tail), and it answers yes with a decision attached.** All **13** patch
hunks anchor against the committed corpus, so a line range per hunk is real and derivable — the
`find` anchor's offset in the file the agent read, converted to lines. `bench/metrics.ts` already
owns the rule and it should not be rewritten: two **different** agents, work windows **overlapping
in time**, **overlapping line ranges** in the **same file**, counted over work that landed.

**What the measurement found, and it is the thing to decide before building:**

| same wave, same file, different agents | line ranges |
| --- | --- |
| `P2a × P2b` — `inventory/repository.js` | **overlap**, 14-16 × 14-16 |
| `C1 × C2` — `orders/repository.js` | disjoint |
| `C1 × C3` — `orders/repository.js` | disjoint |
| `C2 × C3` — `orders/repository.js` | disjoint |

So under `06` §3's rule the run scores **1**, and it comes from the dedupe pair — the two agents
doing *the same work*, which is the one case where overlapping lines are expected. **Interlock 3,
the whole "three features, one file" beat, scores 0**: C1, C2 and C3 edit different regions, and
the naive lane loses two of the three anyway, because its loss mechanism is `demo_shared_state`'s
whole-cell last-write-wins — **file-granular, not line-granular**.

That is not a defect in either the metric or the interlock; they measure different things. But a
meter that renders `conflicting_edits: 0` beside a naive pane visibly missing two of three features
would understate the arm by its own headline number, and `07` §1 makes every rendered figure a
claim. **Three ways out and this is Julian's call, not the unit's:** report §3's rule as-is and say
on the page what it does and does not catch; add a second, named figure for file-level collisions
(what this demo's lane actually loses to); or count the ledger's own overwrite events, which are
already measured. Do not pick one by implementing it.
**Silent break:** U16b's fabrication returning somewhere new. `meter.duplicateWorkDone += 1`
and `meter.lostWrites += 1` were once unconditional and rendered in the same table and style
as figures the driver had timed. Design §6 is explicit that the guard —
`test/scenario.test.ts`'s source scan — must exist **for the new runner before the runner
does**, not after.
**Carry forward unchanged:** `—` means this arm has no such thing to measure, `TBD` means
nobody measured it, and a bare `0` for either is the failure. Nothing unmeasurable is rendered.

**Closed by `npm run gate:workload` (20/20) and `npm run gate:async` (13/13), V52.**
`src/demo/conflicts.ts` is the metric, `test/conflicts.test.ts` (12) its unit tests, and both
figures reach the page through the stream's terminal summary and the meter.

**Two figures, on Julian's call, because the measurement said one was not enough.** `06` §3's
`conflicting_edits` is line-granular and is computed exactly as `bench/metrics.ts` computes it, so
the demo's number and the published benchmark's mean the same thing on the same page. Beside it,
**`fileCollisions`** — agent pairs that wrote one file in overlapping windows, whatever their
lines — because that is what this lane's per-file write-back actually loses to. Measured on a live
run: **naive 3, cortex 0**, where §3's rule reports **0 for both**. Interlock 3 is three agents
editing disjoint regions of `orders/repository.js`, so the metric `06` §3 defines cannot see the
naive lane's most visible failure. Reasoning in `docs/DECISIONS.md`, deviation in
`docs/SPEC-DELTA.md`.

**The done-when's own guard was broken, and that is the unit's sharpest finding.**
`test/workload.test.ts` claimed in a comment that adding an `ArmMeter` field without listing it
would fail — and nothing checked it, because the assertion ran in the opposite direction. A new
meter figure could be added, rendered and set from a literal with the whole file still green. **The
figures such a guard is least able to protect are the new ones.** The list is now derived from
`ArmMeter`'s own declaration and failed the moment the two new fields went in.

**Both versions of the collision window were wrong and `npm run gate:workload` caught both.**
Measuring from ticket pickup reported **1 collision in the cortex lane**, which arbitration makes
impossible — what overlapped was a *blocked* agent waiting, holding nothing and having read
nothing. Measuring to the patch rather than to the save then reported **0 for both lanes beside a
lost hunk**, which cannot both be true: a lost write requires someone to have read before another's
write landed. The window is **read → save**, inclusive of the save.

**A count over an empty list renders exactly like a count over real work**, so `ArmResult` carries
the spans the figures are computed over and the gate asserts they are non-empty — `cortex 9 hunks
placed, naive 12` prints beside the zeros. That is `06` §6's rule applied to a count rather than to
a rate.

**The artifact needed no new storage and no sixth route.** Design §8's running apps are served
through `GET /demo/state` as `files`, projected from the `demo_shared_state` cell `demoState` was
already fetching. `null` before any agent has saved, the tree afterwards — an empty object would
claim the scope produced an app. Live: `cortex 14 files, naive 14`.

**What U25 inherits:** both figures and both trees are on the wire and on the state route; nothing
renders them yet. The naive lane's `fileCollisions` is the number that makes its broken pane read
as evidence rather than as bad luck, and `conflicting_edits` must be labelled as the benchmark's
metric or a reader will take its 0 as a contradiction.

### U24 — LIVE: the run counter, the capability link, the metered cap ✅ 2026-08-16
**Done when:** "one metered LIVE run exists and the cap is derived from it, not estimated."
*(design §11, verbatim)*
**Specs:** `04` §5, `05` §5, `07` §4
**Already banked from U17 (V36):** the counter table exists — `live_run_budget`, one row per
UTC day, atomic check-and-increment, `cortex_demo` confined to today's row with no DELETE. The
Bedrock rate is measured and no longer TBD: **$3.30 per 1M input, $16.50 per 1M output.**

**Closed by two real LIVE runs on 2026-08-16, both arms, eleven tickets each, against the real
cluster and real Bedrock** (`0ded856`, committed just after midnight). From Bedrock's own
`usage`: **16 model calls, 36,892 input and 10,255 output tokens**, which at the measured rate is
**$0.2910 a run**. `METERED_LIVE_RUN` in `src/memory/live-budget.ts` carries those figures, and
`LIVE_RUNS_PER_DAY` is **computed** from them by design §7.3's own formula — `cap = LIVE budget ÷
measured cost of one metered run` — so at `LIVE_BUDGET_USD = 9` it comes out at **30**. The cap is
a literal nowhere, test included: `test/live-budget.test.ts`'s old
`expect(LIVE_RUNS_PER_DAY).toBe(10)` is gone, replaced by a recomputation of the formula, because
a literal there would have gone on passing through exactly the drift this entry used to record.
**If the metered run were `null` or free the cap computes to 0 and LIVE is simply unavailable** —
design §7.3's "until both exist, the config carries TBD and LIVE stays disabled", expressed as a
value rather than a comment.

**Two of the sixteen calls are charged rather than reported, and that correction is what makes
this a measurement.** `modelAuthor` threw on `stop_reason === 'max_tokens'` *above* its own
return, so a truncated call was billed by AWS and reported to nobody. Metering from
`AuthorResult.usage` alone came out at **$0.2478** against a true **$0.2910** — enough to move
the derived cap by a whole run. Truncation is now reported rather than thrown, the answer is
still refused, and `scripts/gate-ladder.mts` charges those calls at a bound rather than an
estimate: output at exactly `FLEET_MAX_OUTPUT_TOKENS`, which is *why* the call stopped, and
input at the largest prompt any call in the run reported. A cost model that under-reports is
worse than one that estimates, because it looks measured.

**Two runs minutes apart reported the same 30,506 measured input tokens, the same 16 calls and
the same 2 truncations** — the prompt is the corpus and the ticket, so the input side is
deterministic; only the output moved, 7,455 then 8,915. The committed figures are the second
run's, so this is **not** a worst case. It is nonetheless conservative overall, because it is
priced at Sonnet 4.5's confirmed rate while the fleet runs Haiku 4.5, whose own line had not yet
appeared in Cost Explorer. That substitution makes the cap a **floor**: when the Haiku rate
lands it can only rise. Re-derive if the corpus, the ticket set or the prompt changes.

**Authorship quality, worth knowing before U19's recording: 10 of 16 and then 12 of 16 hunks
were actually model-authored.** The rest fell back — three "response was not JSON", two
truncations — and the meter partitions them, so the page can say which.

**The route calls `authoriseLiveRun` now**, which is the half of this that used to gate nothing:
`src/demo/api.ts` authorises, and `infra/lambda/runner.ts` **re-compares the capability against
its own copy of the secret**, because it receives a payload it cannot authenticate and a
`live: true` field in it would be a claim rather than a proof. Neither module imports the other;
both import `src/memory/live-budget.ts`. The capability is `live` on the query string, compared
with `timingSafeEqual` behind a length guard, never interpolated, never echoed, never logged; an
anonymous run and a wrong-token run are byte-identical and neither mentions that a gate exists.
**The stack carries both pieces it used to lack:** the capability secret, as a
`{{resolve:secretsmanager:...}}` dynamic reference, and brake 3's Budget, budget action and
`LiveReasoningDenyPolicy` (`ec9e15b`).

**The arithmetic forced the decision this entry refused to guess at.** A whole-event budget is
**not** honestly enforced by a per-UTC-day counter, and the measurement proves it where the
argument could not: the obvious construction, `cap = budget ÷ (days × cost)`, comes out at
**0.9978**, which floors to zero. There is no daily integer meaning "thirty runs over thirty-one
days" — a daily counter cannot express a cumulative budget, and at this budget and this cost it
quantises to nothing at all or to the whole thing. So brake 2 is given the job it can do, bound
the day, and the cumulative bound stays where `04` §5 put it, on brake 3. Trying to make brake 2
do brake 3's job is what produced the zero. **The residual, because there is always one:** AWS
Budgets evaluate against cost data that refreshes a few times a day, so brake 3 is a *bound*, not
an interlock, and spend can overshoot inside one refresh window.

**Settled here, which is what U17 deferred:** the global counter is **part of** `04` §5's brake 1
replacement and not the whole of it. Design §7.2 said it might be and refused to assume; the
answer, with the reasoning in `scripts/gate-ladder.mts`, is the counter (bounds spend) plus the
account's own 10-slot concurrency ceiling (bounds fan-out) plus `LiveReasoningPolicy`, attached
to the fleet runner's role and nothing else. U17's entry carries the full form.
**Rungs 1, 3 and 4 came with this unit**, because LIVE is what rung 1 exhausts:
`npm run gate:ladder` forces all four rungs, a rung 1b and all three brakes — **36/36**.
**A defect that gate found in a day-old file.** `cortexTicket` threw unconditionally when
`applyAndSave` returned null, reasoning that a second cortex agent is deduped before it ever
reads. True — while dedupe runs. Rung 2 skips dedupe by design, and the moment it does, the
second half of a dedupe pair proceeds exactly as the naive lane's does and finds its anchor gone.
So the rung `04` §5 singles out as the one most likely to fire unnoticed produced a **throw
behind the run button**, which is §5 invariant 1's own failure. It now throws only with a real
embedding, and reports the degraded case the way the naive lane reports the same event; that work
counts as duplicate work done, because it was.
**Verify live first:** `npm run probe:reason` — entitlement is an account fact that can change
without this repository knowing — and then the metered run's own Bedrock `usage` figures. **V54
re-verified the first prerequisite** on 2026-08-16: the probe reached the entitled Sonnet 4.5
model in 2104ms and returned Bedrock usage (31 input, 14 output tokens). It did not satisfy the
done-when on its own, and said so; the metered fleet run above is what did.
**Silent break:** the capability token. Three ways it goes wrong and each has cost this
project or a sibling of it real time: it reaches an input element (invariant 8, and
`test/site.test.ts` is the guard); it is interpolated into SQL or a template rather than
**compared** (invariant 7 — a URL parameter is the most agent-reachable path there is); or it
lands in `cdk.out/` as a template value instead of a `{{resolve:secretsmanager:...}}` dynamic
reference, which is exactly how the first DSN arrangement leaked and why that rule exists. All
three held: the token is compared, the page reduces it to a boolean before rendering and has zero
input elements, and the secret is a dynamic reference.
**And the finding brake 3 depended on was spent, not just carried.** An AWS Budget filtered on
the `Amazon Bedrock` service would never have fired, because that service carries only the Titan
embedding line. `aws ce get-dimension-values --dimension SERVICE` returned all three names, so
the Budget filters on `Claude Haiku 4.5 (Amazon Bedrock Edition)` and `Claude Sonnet 4.5 (Amazon
Bedrock Edition)` exactly. Sonnet is included although the fleet runs Haiku, because
`bench/reason.ts` calls Sonnet and a brake that ignores half the reasoning bill has a hole.

### U25 — The new SPA 🔶 **implementation complete 2026-08-17; independent cold read still open**
**Done when:** "the four beats read clearly to someone who has not seen it."
*(design §11, verbatim — the same sentence U16 was held to)*
**Specs:** `07` §2, `07` §3, `02` §B
**Now also renders both apps.** Two iframes fed by `srcdoc` from the two final file trees —
no network, so nothing to fail — with each missing feature linked to the agent that reported it
done. That link is what makes the naive app evidence rather than an assertion.

**Built in V53 and revised from Julian's read in V55.** `infra/site/index.html` is now the
single-page judge instrument: one run control opens two five-agent swimlanes, committed rows and
fleet activity are labelled as different sources, and all eleven tickets carry live state. The
abstract topology graph has been replaced by five developer-agent cards operating on named
repository files around the CORTEX logo; every movement is driven by the matching fleet event.
The page explains the five coordination actions in plain language, exposes the workload's three
failure hazards, runs both returned file trees in sandboxed `srcdoc` frames, and derives its
outcome comparison from those trees and terminal meters rather than declaring a winner in copy.
The meter distinguishes measured zero, not applicable and unmeasured values. Opening the source
file directly uses a clearly labelled simulated stream and includes both a completed run and a
partial-failure path; deployed endpoints still select the real route.

The real-cluster workload gate passed after the revision: CORTEX lost **0** writes and had **0**
file collisions; the naive worktree lane lost **2** writes, had **3** file collisions, repeated
one semantic duplicate and walked one extra dead end. The page receives those differences from
the run; it does not manufacture them. The first of the two permitted gate runs missed two
timing-dependent informed-patch interlocks while still producing the same directional outcome;
the required re-run recalled both findings and passed every check. V55 records both outcomes.

**Connected and published in V56.** The deployed page creates both demo scopes, opens one
WebSocket per scope, accepts the fleet and terminal stream from the primary connection only, and
accepts tenant-scoped committed rows from both. That prevents duplicate fleet events while making
the naive arm's real changefeed rows visible. Both final states and SQL transcripts were already
fetched per scope; the missing second row stream was the last browser-to-system wiring gap.

**Two things the run could always prove and the page never showed, added 2026-08-17 (`6096bd3`).**
A **timeline**: one lane per agent per arm on a shared scale, every bar built from the fleet
events already on the wire. A blocked span draws to the holder; a deduped or spared agent's bar
**stops early**, and the empty remainder is the point, because that is time and money never spent;
collision bands mark where two naive agents' read→save windows overlap on one file, and the cortex
lane has none because a cortex agent holds its claim across read, work and save. Nothing is
manufactured for the comparison — there is no synthetic serial baseline, because a made-up "what
this would have cost sequentially" is precisely the fabrication `07` §1 forbids. And the **mode
line inverted, and had to**: it used to append a fixed sentence saying a person wrote and reviewed
the code, which was true while the runner made no model call and false the moment `modelAuthor`
runs. It is now derived per run — whether the code was model-authored or replayed, that database
behaviour, arbitration, races and the changefeed are live in **both** modes, and how many hunks
the model actually wrote versus how many fell back. Varying outcomes are framed before the run
rather than excused after it: an uninformed model sometimes gets the money representation right
and interlock 1 honestly does not fire, so the page distinguishes "not observed on this run" from
"did not happen" from "not measured", the discipline the meter already applied to measured zero,
N/A and TBD. 86 site tests; the inline script is parsed with `node --check`, because a syntax
error there renders a blank frame with no error anywhere; zero inputs, forms, textareas or
selects, asserted against the source.

**Why this remains partial:** Julian approved the direction and supplied the judge-facing
revision, but the done-when specifically requires someone unfamiliar with the project. V53/V55
prove the bindings, security surface, syntax and result derivation; they do not turn an owner read
into an independent cold read. Design decision 7 held the old page in front of visitors until the
new one passed its checks; the new page has been the deployed one since V56, and U26 carries the
deploy.

**If time runs out, this is what gets cut** (design §11). The current page then renders the new
run through its existing three panels: uglier, real, already gate-passed, and nothing built is
lost. Design decision 13: the runner is the evidence, the page is the presentation.
**Silent break:** a credential field, under any name, including commented out or feature
flagged off. Invariant 8, `02` B3, `05` §5, and the reason design decision 9 chose a capability
URL over the password that was originally asked for.
**Second silent break:** an animation implying an ordering the database did not produce.
Design §9 motion rule 3 — beat 3's winner is decided by the unique index, so neither lane may
be pre-positioned to win, and a page that animates one is depicting a determinism the system
does not have. Rule A7.

### U26 — Deploy and cold read 🔶 **redeployed 2026-08-17; Julian's cold run still open**
**Done when:** "Julian opens the deployed page cold and the run reads." *(design §11, verbatim)*
**Specs:** `02` §B, `04` §5
**Verify live first:** `node infra/bundle.mjs` before `npx cdk deploy`. Nothing runs it
automatically and a stale bundle deploys silently, which is why the handler carries a
`BUNDLE_REVISION` bumped by hand — and why that marker is not sufficient on its own, below.
**Silent break:** the deploy appearing to succeed while serving the previous bundle. U14 built
the revision marker for this, and **the break happened anyway on 2026-08-17, in the one shape
the marker cannot catch** — see below.
**This one cannot be closed by a script**, exactly as U16 could not. Design §13 names the risk
plainly: the rebuilt page may be correct and less readable than the one it replaces, and only a
cold read rules that out.

**Published in V56:** https://d11xbslgdgomdp.cloudfront.net. The deployment injected the current
CloudFormation API and WebSocket outputs, invalidated the distribution, and a cache-busted fetch
returned the new two-scope runtime, judge workflow and CORTEX hub at HTTP 200.

**Redeployed 2026-08-17 (`f09fe34`), because the deployed runner was serving the headline claim
inverted.** `e35cacc` fixed `lostWrites` at 01:27; the bundles were built at 00:59 and
CloudFormation last updated `DemoFn` and `RunnerFn` at 01:02 — twenty-five minutes before the fix
existed. So the public URL had been serving the accounting error the whole time, and in LIVE mode
it reported **CORTEX losing more writes than the naive lane**. Proved rather than inferred, both
ways: `aws lambda get-function` on `RunnerFn`, unzipped, `grep -c writtenByTicket` returned **0**
before and **4** after, against 4 in the tree. Demo revision 7 → 8, runner 4 → 5.
**`BUNDLE_REVISION` could not have caught this, and the constant's own comment now says so.** The
marker is bumped when a *handler* file is edited. `e35cacc` edited `src/demo/workload.ts`, which
is merely **bundled into** the runner — deployed behaviour changed while `infra/lambda/runner.ts`
did not, so the marker read 4 on both sides of the fix. It proves a deploy landed; it does not
prove the bundle is current with the tree. The check that does is downloading the deployed bundle
and grepping it for the fix's own symbol.
**`npm run gate:async` passed against the redeployed stack**: 90 fleet events, one terminal
message and nothing after it, 43 real changefeed rows, cortex **0** collisions against naive
**2**. The gate runs REPLAY, where the two sides of the `lostWrites` readback are the same string,
so it cannot exercise the fix — the bundle grep is the evidence that the fix is deployed, and a
LIVE run is what exercises it.
**Still required to close this unit:** Julian opens that URL without project context, runs it
once, and says whether the four beats read.

---

### U2 — `cortex init` ✅ 2026-08-16 — **the full entry is at the top of this file, with day one**

Kept as a pointer rather than a second copy: two entries for one unit is exactly the drift this
file's own header forbids, and the day-one entry is where the deferral reasoning already lived.

Two things recorded here that the day-one entry does not carry, because they were written as
predictions and both came true:

- **The verify-live-first said "that `ccloud` can provision".** It cannot — `ccloud` is not
  installed on this machine — and that is what turned the unit provisioning-optional rather than
  blocking it. The prediction was answered by checking, and the answer changed the shape.
- **`docs/SPEC-DELTA.md`'s "`cortex bench` vs `npm run bench`" entry does NOT close**, contrary to
  what this entry predicted. `bench` is deliberately not a subcommand. The entry is corrected in
  place; the README publishes the names that work, which was the actual requirement.

### U18 — README, architecture diagram, licence, third-party disclosure ✅ 2026-08-16
**Done when:** "a clean clone reproduces the benchmark." *(08 §5, 47–52h, verbatim)*
**Specs:** `09` §1, `07` §7, `02` §B

**Closed by running it, V57.** `git clone` to an empty directory, `npm ci`, `npx tsc
--noEmit` clean, `npm run bench:results`. **Every coordination row is identical to the
published table**; only `claim_p50` (732 → 778) and `claim_p95` (818 → 967) moved, which is
the wall-clock variation both `summary.md` and the README tell a reader to expect. Both run
records carry `mode=replay` and `liveCalls: {embed: 0, reason: 0}`, so no network was
reached.

**The run found a defect reading could not, and it was a reproduction blocker.** The
committed `summary.md` named `CORTEX_DSN` as the only prerequisite — true on 2026-08-12,
false since V48 moved the write plane to `CORTEX_WRITER_DSN`. A judge configuring exactly
what the published artifact asked for would have watched the CORTEX arm fail.
`scripts/bench-results.mts` was corrected on 2026-08-13 (`fe3da84`) and **the artifact was
never regenerated**, so the fix reached the generator and not the file anybody reads — the
same corrected-source-and-stale-copy shape as V39's changefeed sink. The prerequisite
paragraph now carries the generator's own current wording; **no published number moved and
the results directory is still singular.**

**Five factual errors were corrected in the diagram before it shipped**, all found by
reading `infra/cdk/lib/cortex-stack.ts` rather than the prose beside it: four Lambdas where
five are deployed (the fleet runner was missing), one DynamoDB table where there are two,
Secrets Manager absent, S3 labelled as holding cassettes/fixtures/results when it holds only
the SPA, and — the one that mattered — **Claude Sonnet 4.5 drawn inside the AWS boundary.**
Every `bedrock:InvokeModel` grant in the stack is scoped by ARN to the Titan embedding model,
so no deployed function can invoke a reasoning model at all. Depicting LIVE reasoning as
wired is exactly what rule A7 forbids. `docs/architecture.md` now states that explicitly, and
the AWS Budget alarm and degradation rungs 1, 3 and 4 are labelled **not built** rather than
listed as if they exist.

**`.env.example` was the other thing standing between a clean clone and a working one**, and
it is **not fixed** — the file is behind a read/write deny rule in this session's permission
settings, so the corrected version is parked outside the repo for Julian to install. It
labels `CORTEX_DSN` the write plane (false since V48), omits `CORTEX_WRITER_DSN`,
`CORTEX_READER_DSN`, `CORTEX_DEMO_DSN` and `CORTEX_CORPUS_ROOT` entirely, and carries
`CORTEX_DEDUPE_THRESHOLD` (removed by `05` §6) and `CORTEX_LEASE_TTL` (read by nothing since
U9 decided against lease extension). The README's own variable table carries the true set, so
a reader following the README is not blocked; a reader following `.env.example` is.

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
  a credential-shaped value on the body or the query string comes back 400 naming the field.
  `02` B3 is a rule most submissions can only assert; this shows it being enforced. Do not
  paste the string into this file to describe the take — quote the verdict.
- **`npm run gate:ladder`** (new, from U24). All four of `04` §5's degradation rungs, a rung 1b
  and all three brakes forced deliberately in one command: **36/36**, and every rung ends in a
  working page rather than an error. `npm run gate:degrade` is the same script under its older
  name. It is the shortest evidence for the whole guardrail story, which is otherwise a
  paragraph of claims. Only `-- --meter` calls a reasoning model; the plain run spends
  embeddings and cluster time, so a take costs nothing that needs rationing.

### U20 — Devpost description, B10 and B11 answers, feedback field ✅ 2026-08-16
**Closed by `docs/submission-devpost.md`** — the description, the B10 and B11 answers, the
B13 feedback field, and `02` §F walked item by item: **7 ready, 3 partial, 5 blocked, 1
act.** Rules re-fetched 2026-08-13 and again read against `02`: **no change detected**, with
B4, A11, B2 and the amendment clause (still §11.5) re-pulled verbatim.

**The named silent break was worse than written, and it is the unit's finding.** `02` §C
cannot ship for four reasons, not one. Items 1, 3 and 4 route reads through the managed MCP
server (V17). Item 3 also claims `cortex init` provisions clusters through the ccloud CLI —
`grep -rn ccloud src scripts package.json skills infra` returns **nothing**; U2 is not built.
Item 4 claims the agent consumes `cockroachlabs/cockroachdb-skills`, a string that appears
**only under `spec/`**. So **`02` A4's "4 of 4 tools used" is false; it is 2 of 4** —
Distributed Vector Indexing and Agent Skills. That still clears the rules' minimum of two,
and B10 now says so outright rather than being caught saying otherwise. **`02` §D cannot
ship either:** EventBridge is not in the stack and AWS Budgets is not built, while DynamoDB
and Secrets Manager are deployed and §D omits both.

**Revised 2026-08-16, and the revision is the reason this unit is not a write-once.** The
first draft was correct on 2026-08-13 and *understated the submission* by 2026-08-16: it
said the ten-ticket two-arm workload was designed and unbuilt, which U21–U23 and the
deployed judge page (V56) had already made false. Understating is the same class of error as
overstating, so §1 now describes the real workload — both lanes, the streamed agent steps,
the two running applications — and says plainly that the patch bodies are committed and no
model wrote them. **The measured lane figures carry the caveat that they are races:** the
direction reproduces, the digits are whatever the run reports.
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
