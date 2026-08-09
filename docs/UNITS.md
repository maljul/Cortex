# Units of work

The decomposition `spec/11-SHIP-LOOP.md` §5 calls for. Its blocks are three to six
hours, which is too coarse to survive one context — this file cuts them into units
that fit in one, each with the four things `/lh-next` has to output.

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

### U8 — `cortex_propose` tool ⬜
**Done when:** a real coding agent attaches and successfully proposes. *(08 §4, 16–20h)*
**Specs:** `05` §3, `03` §4.2
**Silent break:** letting `blocked` or `deduped` surface as a tool error. They are
normal return values; an agent that sees an error will retry through a block, which
turns the fleet into a queue — the exact behaviour `03` §5 forbids.

### U9 — `cortex_close` and `cortex_heartbeat` tools ⬜
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

### U10 — Agent Skill and the managed-MCP read path ⬜
**Done when:** "agent recalls without any bespoke client." *(08 §4, 20–23h, verbatim)*
**Specs:** `05` §4, `03` §4.1
**Verify live first:** that the managed MCP server accepts the recall SQL under
`cortex_reader`.
**Silent break:** shipping recall SQL in the skill that omits `WHERE repo_id`. Per V5
that fails open across tenants, and this is the one query that leaves the repo.

### U11 — Benchmark fixtures and task list ⬜
**Done when:** the corpus and the overlapping-task share exist and are committed.
**Specs:** `06`
**Silent break:** too little task overlap. `08` §7 names this: a benchmark showing no
difference means overlap is too low, not that the mechanism does not work.

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
- **The video is recorded in LIVE mode** at 52–58h, and LIVE reasoning now runs on a
  4-5 model. Confirm that path end to end before the recording session, not during it.
- **`08` §7 says deploy a hello-world through the full pipeline on day one evening**,
  not on day three. Deployment eating day three is the medium-likelihood, high-impact
  risk in the register.
- **U2 `cortex init` lands here**, deferred from day one — see its entry above for
  why, and do not let it drift further than day three.

Not yet captured, worth screen-recording (`08` §5, 52–58h):

- **An unmodified third-party agent attaching to `npm run serve` and listing the
  three tools.** The whole prompt-surface argument in `05` §3 is that no bespoke
  client is needed, and that is far more convincing seen than described. Not worth
  recording until U8 makes `cortex_propose` actually decide — a tool list that
  answers "not implemented" demonstrates the opposite of the claim.
- The two-terminal contention gate (U6) is already reproducible on demand via
  `npm run gate:contend`, but no take has been recorded.
