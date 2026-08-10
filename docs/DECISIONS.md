# Decisions

Decisions that closed something, with the reasoning that closed it. One entry per
decision, newest last. If a decision is later reversed, correct the entry in place
and say why — do not append a contradiction.

---

## 2026-08-09 — Heartbeat and lease extension will not be implemented

`08` §6 ranks heartbeat and lease extension as cut-list item 6, and the decision has
been taken now rather than under time pressure on day three. U9 is `cortex_close`
only. Long-running work gets a longer fixed lease instead of a renewable one.

The reasoning: a renewable lease has to verify that the caller still holds the intent
before extending it, or a dead agent's lease gets renewed by whoever asks — which is
worse than no heartbeat at all, because it converts an expiry that would have freed
the key into one that never fires. That check is not hard, but it is a correctness
surface on the critical path, and the alternative costs one constant. A fixed lease
long enough for the benchmark's slowest task has the same failure mode as a short one
(a dead agent's keys are unavailable until expiry) and simply sets the constant higher.

What was kept: the tool is still advertised and its schema is now settled in `05` §3,
served by U7. So this stays a scheduling decision — if day three turns out to have the
hour, implementing it changes no other surface. Calling it today returns
not-implemented, which is honest, rather than a silent no-op that an agent would read
as a successful extension.

Cost saved: roughly an hour on the day-two critical path.

## 2026-08-09 — Node for everything; `05` §2's runtime `[OPEN]` is answered in practice

`05` §2 leaves Node versus Python open for the CLI, with a mild preference for Node
because `npx` gives zero-install onboarding. The repository has in fact been Node and
TypeScript throughout — cluster access, embeddings, arbitration and benchmark
scaffolding — and B1 committed to one module system across all of it with a clean
`npx tsc --noEmit`. A split runtime would now mean adding a toolchain, not choosing
between two.

**The `[OPEN]` marker in `05` §2 has not been edited.** Closing it is Julian's call,
not a side effect of a build fix; it is recorded in `docs/SPEC-DELTA.md` as stale so
it is not re-litigated by whoever reads §2 next.

## 2026-08-09 — `repo` on the tool surface is a slug, resolved to `repo_id` on first sight

`05` §6 hands an agent `CORTEX_REPO`, a slug; `03` §2 keys every table on a
`repo_id` UUID. Everything before U8 was handed that UUID by its caller, so the tool
surface is the first place the tenant boundary has to be *derived*. `src/memory/repos.ts`
resolves the slug through the `repos` table — read, then insert on conflict do
nothing, then re-read outside that transaction because its snapshot predates a
concurrent commit and a second read inside it can legitimately see nothing.

Two things were decided rather than defaulted. The slug is **case folded**, unlike
the path body of a resource key, because the costs are asymmetric: two spellings of
one file are two files on a case-sensitive checkout, but two spellings of one remote
are one repository, and splitting a tenant in two leaves both halves granted with no
error anywhere. And the insert deliberately does **not** join the arbitration
transaction: it is not part of the all-or-nothing claim set, and putting the one row
every agent in a fleet touches inside the SERIALIZABLE claim transaction would
manufacture 40001s on the critical path of every proposal. It goes through
`withRetry` on its own, which invariant 6 requires and which six concurrent
first-calls in the test suite exercise.

## 2026-08-09 — `glob:` keys are never silently narrowed *(extended 2026-08-10: they are now expanded when a root is configured)*

**Superseded in part, and corrected here rather than contradicted below.** The decision
that held was the second half — never claim the bare `glob:` row. What changed on
2026-08-10 is that the server no longer *only* refuses: `05` §6 gained
`CORTEX_REPO_ROOT`, and when it is set `cortex_propose` expands a glob into one claim
per matched file plus the glob row, which is the overlap `03` §3 asks for. With it
unset the refusal below still stands, for exactly the reason given below.

The original entry:

`03` §3 makes a glob's overlap structural: a glob is claimed as one row per matched
file *plus* a row for the glob itself, which is what makes a later `file:` claim on a
matched path collide. That expansion needs a checkout to match against, and `05` §6
configures the MCP server with no repository root — it is launched by an agent from
wherever that agent happens to be.

The tempting shortcut is to claim the bare `glob:` row and move on. That is the worst
available option: it looks like it worked, and it leaves every `file:` claim the glob
should have covered unblocked. A double grant with no error is exactly the failure
this project exists to prevent. So `cortex_propose` refuses a glob and says why, which
matches §3's own stated default of refusing rather than claiming at directory
granularity. `expandKeys` still supports globs through its injected resolver, so a CLI
that does know the repository root loses nothing.

**This is a narrowing of what `05` §3's published schema advertises** — its
`resource_keys` description names `glob:<pattern>` — and it is recorded in
`docs/SPEC-DELTA.md` rather than fixed by editing the description, because the
description is prompt surface pinned verbatim against the spec by a test.

## 2026-08-09 — `cortex_close` requires its repository; only `cortex_propose` registers one

`src/memory/repos.ts` exposes two resolvers rather than one. `resolveRepoId`
registers a repository on first sight and belongs to propose, which genuinely is the
first thing a new repository does. `requireRepoId` refuses an unknown slug and is
what close uses.

The reasoning is about which error a caller gets. A close is never legitimately the
first call a repository makes — there is nothing to close until something has been
proposed — so an unrecognised slug at that surface is a typo, near-certainly in
`CORTEX_REPO`. Registering it would succeed, mint an empty tenant, and then answer
"no intent <uuid> in this repo", which is true, unhelpful, and points the caller at
their intent id instead of at the one character they got wrong. It would also leave a
junk row behind on every occurrence. Refusing says "unknown repo" and names the
actual fault.

The same rule will apply to `release`, and would have applied to `heartbeat` had it
not been cut.

## 2026-08-10 — Recall is issued as `cortex_reader`, not through the managed MCP server

`04` §3's read plane routed agent reads through the CockroachDB Cloud Managed MCP
Server. It no longer does. Reads are issued directly as `cortex_reader` over
`CORTEX_READER_DSN`.

**What forced it.** V17. That server executes as SQL user `managed-mcp`, which holds
`INSERT` and `DELETE` on `claims` and `INSERT` on `intents`. Confirmed by invoking
`insert_rows` against `claims` and getting **23502**, a NOT NULL violation, rather than
**42501** — the privilege check ran ahead of the constraint and passed. It also
publishes `insert_rows`, `create_table` and `create_database` as tools, so being a read
plane could never have been a property of the server; it had to be a property of the
principal, and it is not.

The failure this avoids is worse than a broken invariant. An agent holding that
endpoint does not violate the arbitration transaction — it never enters it. It writes
`claims` directly, and all eight `03` §8 invariants are bypassed rather than broken.
`05` §4's Agent Skill would have shipped that endpoint next to the recall SQL, under a
section reading "never write directly to the database", which no document can enforce
against a tool named `insert_rows`.

**The option not taken** was constraining `managed-mcp` to a `SELECT`-only SQL
identity. Nothing measured suggests that identity is configurable — the Cloud service
account is an organization-level principal that `GRANT` does not apply to, and the SQL
user it maps to was not chosen by this project. Its best case was arriving where the
alternative already stood.

**What is given up, stated plainly.** "Governed by Cloud RBAC and audit logging rather
than by code you wrote" leaves the architecture story. It was the more impressive
sentence. It was also false, and a judge can run `npm run probe:read` and find that out
in thirty seconds.

**What replaces it is stronger, and that is the actual argument.** The read plane's
read-only property is now a SQL grant asserted by `test/privilege-planes.test.ts`,
which attempts an `INSERT` on all six tables as `cortex_reader` plus an `UPDATE`, a
`DELETE` and a `DROP`, and requires all nine to refuse with 42501. It reads no
catalogue, because V9 found every service account holding `admin` through a role
membership `SHOW GRANTS ON TABLE` answered truthfully without revealing. "Here is a
test you can run" beats "the platform handles it".

**Consequences.** `04` §1, §3 and §4 and `05` §3, §4 and §6 are corrected in place.
`CORTEX_MCP_*` stays in `.env` for `npm run probe:read` only, labelled as diagnostics.
U10 is unblocked and its shape changes: the skill ships the recall SQL against
`cortex_reader`, pinned byte-for-byte against `src/memory/recall.ts` so both `repo_id`
predicates cannot drift out of it (V14).

## 2026-08-10 — The benchmark serialises its fleet, and gives up two metrics to do it

`06` §5 requires the re-run to be reproducible from a clean clone plus a cluster, and
asks for "simulated clock offsets so contention is forced deterministically rather
than hoped for". U12's scheduler takes that literally: five agents each hold a virtual
clock, and the scheduler repeatedly runs one step of whichever agent is furthest
behind. Exactly one step is ever in flight.

**What that buys.** Two runs of one arm at one seed produce identical decisions,
against a live SERIALIZABLE database, which `test/bench-runner.test.ts` asserts by
running each arm twice rather than by inspecting one run. Contention is not simulated:
agent B really does find agent A's row in `claims` and really is told who holds it.

**What it costs, stated rather than discovered later.** Two transactions never overlap,
so the harness produces no `40001` retries and `claim_p50`/`claim_p95` are uncontended
latencies. `06` §3 lists `serialization_retries` as a metric; measured here it will be
0, and 0 is a fact about the harness, not about the mechanism.

**The alternative was worse.** Racing five real processes is what actually produces
retries, and it is what `08` §4's end-of-day-one gate already does — `npm run
gate:contend` contends two processes for one key and V13 forces a genuine `40001`
between two interleaved clients. Doing it again inside the benchmark would trade the
reproducibility §5 demands for a number two other pieces of evidence already carry, and
a benchmark whose figures move between runs is worth less than one that admits its
scope. The race is proven; the benchmark measures wasted work.

**Consequence for U13.** Report `serialization_retries` and the claim latencies as what
they measure, with the harness's serialisation named beside them. Do not omit the rows
— an absent metric reads as a hidden one — and do not quote U6's contention as a
benchmark result.

## 2026-08-10 — The NAIVE arm keeps last-write-wins, and publishes the loss rate

`06` §2 specifies the naive arm's shared state as "JSON file on disk, last-write-wins",
and §2 also requires it to be a fair representation of what people actually do rather
than a strawman. Implemented literally — read the file, work, write the whole file back
from the pre-work snapshot — it loses 21 of the 28 writes it acknowledges (V19). That
is a striking number and the temptation was to soften it.

**It was not softened, for a reason that is about honesty in both directions.** The
obvious softening is to re-read and merge at save time. That is no longer
last-write-wins, so it is no longer what §2 specifies; worse, it would be *flattering*
in a way this harness cannot justify, because the scheduler serialises steps, so a
read-merge-write would appear atomic here and would not be atomic between two real
processes. The naive arm would then lose almost nothing for a reason that is an
artefact of the test rig.

**What fairness did buy the naive arm.** Its local vector store is one file per note,
so it never loses a memory — real vector stores handle concurrent inserts, and nothing
here is arranged to make the naive arm bad at remembering. It currently has *more*
working recall than the CORTEX arm, whose `findings` table waits on consolidation
(`03` §4.4). That asymmetry is recorded in the run record and in V19 rather than
quietly corrected.

**What ships with the number.** §7.5 says publish a metric that moves the wrong way and
explain it; this one moves the right way and still needs its mechanism published beside
it, because a 75% loss rate with no explanation reads as a manufactured benchmark to
exactly the audience being addressed. The mechanism is one sentence: a whole-file
rewrite from a stale snapshot leaves the file holding what the last saver happened to
have seen.
