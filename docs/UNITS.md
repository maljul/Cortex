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

**Pick it up at day three, with infra and deploy.** If day three runs short, `08` §6
does *not* list it as cuttable, so it comes before the demo SPA polish, not after.

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

### U10 — Agent Skill over the `cortex_reader` read path ⬜ **UNBLOCKED 2026-08-10**
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

### U12 — Five-agent runner and cassettes ⬜
**Done when:** "`cortex bench` runs both arms deterministically." *(08 §4, 23–29h, verbatim)*
**Specs:** `06`
**Silent break:** non-determinism leaking in through model calls or wall-clock time,
so two runs of the same arm disagree and the published number is unreproducible.

### U13 — Metrics, duplicate judge, results writer ⬜
**Done when:** "`bench/results/` populated and committed." *(08 §4, 29–32h, verbatim)*
**Specs:** `06`
**Silent break:** a placeholder number reaching a results file. Write TBD.
**End-of-day-two gate:** the summary table shows a real difference between the arms.
From that moment the project is submittable even if everything else fails.

---

## Day three — the surface (decompose at the start of day three)

Coarse on purpose. In `08` §5 order: infra and deploy (32–38h) · demo SPA (38–44h) ·
guardrails and all four degradation rungs (44–47h) · README and disclosure (47–52h) ·
video (52–58h) · Devpost (58–60h).

Three things carried forward that must not be forgotten:

- **§8 test 9** — `cortex_demo` cannot write outside a live session scope. Blocked on
  the `04` §3 `[OPEN]`, and V5 narrowed it: confinement cannot rest on the index
  prefix, so it has to come from the principal's grants.
  **Partly guarded since 2026-08-10 (V15).** `test/privilege-planes.test.ts` asserts
  the planes by attempting writes rather than reading grants, which is what V9's
  hidden `admin` membership requires. The reader half is green — 14 assertions, every
  refusal on SQLSTATE 42501. The demo half is **red pending `CORTEX_DEMO_DSN`**, which
  is a credential this repository does not hold; that is deliberate, because a skipped
  privilege test reports green over an unasserted boundary. What it will assert is
  still weaker than test 9 — "no privilege at all" rather than "none outside a live
  session scope" — and it is written to fail, not to keep passing, once `04` §3 is
  decided and scoped grants exist.
- **The video is recorded in LIVE mode** at 52–58h, and LIVE reasoning now runs on a
  4-5 model. Confirm that path end to end before the recording session, not during it.
- **`08` §7 says deploy a hello-world through the full pipeline on day one evening**,
  not on day three. Deployment eating day three is the medium-likelihood, high-impact
  risk in the register.
- **U2 `cortex init` lands here**, deferred from day one — see its entry above for
  why, and do not let it drift further than day three.

Not yet captured, worth screen-recording (`08` §5, 52–58h):

- **An unmodified third-party agent attaching to `npm run serve`, listing the three
  tools, and proposing.** The whole prompt-surface argument in `05` §3 is that no
  bespoke client is needed, and that is far more convincing seen than described.
  **Now worth recording:** U8 makes `cortex_propose` decide, and the verification log
  carries a granted / blocked / deduped transcript from a client with no MCP SDK.
  What is still not captured is a real coding agent driving it, which is the take to
  record — the text transcript is the proof, the agent is the demo.
- The two-terminal contention gate (U6) is already reproducible on demand via
  `npm run gate:contend`, but no take has been recorded.
