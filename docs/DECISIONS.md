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

## 2026-08-10 — The judge scores at 0.40, and the mechanism kept 0.28 *(superseded 2026-08-11)*

`06` §3 requires `duplicate_work_rate` to be computed by an offline judge that does not
share code with the dedupe path. The judge therefore needs a threshold of its own, and
there were two candidates: reuse `DEFAULT_DEDUPE_THRESHOLD` from
`src/memory/propose.ts`, or pick one from the sweep.

**Reusing the mechanism's constant was rejected.** It would score the CORTEX arm with
the yardstick the arm was built from, so a threshold error would cancel out of the
result and the arm would report a duplicate rate of 0 whatever the corpus actually
contained. That is precisely the "measuring a mechanism with itself" §3 names, and it
would survive review right up until someone noticed the two numbers were the same.

**0.40 comes from the sweep.** The corpus separates at (0.3630, 0.4293) — every
declared pair below, every undeclared pair above — measured by the judge's own cosine
over the committed cassettes. 0.40 sits in the middle of the band where recall and
precision are both 1.000.

**The consequence was published rather than tuned away.** At the shipped 0.28 the
mechanism catches four of six pairs, so the CORTEX arm's `duplicate_work_rate` is 0.08
rather than 0.00, and the two residual duplicates are exactly the pairs 0.28 misses.
Changing `propose.ts` to 0.40 would zero that row — and would be the benchmark editing
the mechanism it scores, inside the unit that computes the score. `03` §4.2 marks the
constant `[OPEN]` and empirical; closing it is Julian's call with the sweep in front of
him, which is what the sweep is for.

## 2026-08-10 — `goodput` is measured on the simulated clock

`06` §3 defines `goodput` as "distinct completed tasks per wall-clock minute". Measured
that way here, the NAIVE arm wins by roughly three orders of magnitude — it writes a
local JSON file while the CORTEX arm makes ~120 sequential round trips to a cloud
database. The number would be real and would mean nothing about coordination.

**Goodput is therefore reported per *simulated* minute**, the timeline both arms share
and the one the fleet's think-times and work durations are defined on. Stated in
`summary.md`'s limitations rather than buried: wall-clock goodput would compare a file
write against a network round trip and call the difference a result.

**Distinct** is also doing work in the definition: the count is tasks present in the
arm's final state that the judge does not consider duplicates. Work that was lost is
not throughput, and work that repeated an earlier task is not distinct.

## 2026-08-10 — Infrastructure as code is CDK, and the ten-minute rule did not decide it

`04` §2 and `08` §8's D2 both left CDK-versus-SAM open and both proposed the same
tiebreaker: whichever can be deployed reliably in under ten minutes, because deployment
friction on day three is what kills submissions. Both were built and both were timed
against this account (V22): identical four-resource stacks, the same pre-bundled Lambda
artifact, cold and redeploy measured separately because a cold number is dominated by
CloudFront distribution creation and by one-time toolchain cost that never recurs.

CDK redeploys in **42s**, SAM in **33s**. Both are roughly fifteen times inside the bar.

**So the criterion tied, and saying otherwise would have been the dishonest option.** A
nine-second difference is not a measurement of anything, and picking SAM "because the
redeploy column decides" — which is the rule agreed before measuring — would have dressed
a coin toss as evidence. The rule was written expecting a separation that did not appear.

CDK was chosen on the remaining question: what the source looks like for the resources
still unbuilt. CloudFront with an origin access control is eight lines of CDK and about
fifty of raw CloudFormation under SAM, including a managed cache-policy UUID that has to
be looked up by hand. U14 adds a WebSocket API, EventBridge, a changefeed ingress,
reserved concurrency and a budget alarm, and every one of those widens that gap. `08`
§8's written fallback ("if that is neither, pick SAM") was not followed, deliberately: it
addresses a tie on *familiarity*, and the tie that occurred was on speed.

The cost of being wrong is bounded and known: the whole stack is 90 lines and redeploys
in under a minute, so switching later costs an hour, not a day.

## 2026-08-10 — The hosted DSN is a dynamic reference, not a Lambda environment value

`05` §6 requires every DSN to be server side only, and the first version of the spike
stack satisfied that reading — `process.env.CORTEX_READER_DSN` at synth time, set as a
Lambda environment variable, nothing in the bundle and nothing in the SPA. It was still
wrong, and V22 found it by grepping the artifact rather than by reasoning about it: the
synthesized template carried the DSN inline, so the value sat in `cdk.out/` on disk and
in CloudFormation's stored copy, readable by anyone holding `cloudformation:GetTemplate`.

The stack now uses `SecretValue.secretsManager(...)`, which synthesizes
`{{resolve:secretsmanager:cortex/reader-dsn:SecretString:::}}` and lets CloudFormation
resolve it at deploy time. The secret is created out of band so its value passes from the
shell to Secrets Manager without ever touching this repository.

**Recorded because the near-miss is the useful part.** The rule as written in `05` §6 was
obeyed and the credential still leaked into an artifact, because "server side" and "not
in the repository" are not the same property as "not in the deployment template". The
general form: a credential handling rule is satisfied by inspecting the outputs, not by
inspecting the intent.

## 2026-08-11 — The dedupe threshold moves to 0.39, and the benchmark is republished

`03` §4.2 marked `DEDUPE_THRESHOLD` `[OPEN]` and empirical from the beginning, and asked
for a sweep over the benchmark corpus. The sweep exists (U13), reproduces U11's band to
the digit, and says the same thing both times: the corpus separates at (0.3630, 0.4293),
and the shipped 0.28 sat below the band, catching 4 of 6 declared pairs with no false
positives. Recall was the problem; precision never was.

**Closed at 0.39.** All six pairs caught, zero false positives, and CORTEX's
`duplicate_work_rate` goes 0.08 → 0.00 with `wasted_tokens` 1975 → 867 — the two pairs
0.28 let through were being reasoned about at full cost.

**It is deliberately not 0.40, which is also in the band.** 0.40 is `JUDGE_THRESHOLD` in
`bench/metrics.ts`. The judge scores the benchmark that justifies this constant, and the
two carrying one number would read as the mechanism and its scorer having been tuned
together — which is the objection `06` §3 exists to anticipate, and it is cheaper to
avoid the appearance than to argue about it. They were picked independently and the
values now say so. The band is wide enough that this costs nothing: 0.38, 0.39, 0.40 and
0.42 all score recall 1.000 and precision 1.000.

**On the circularity, since this is the edit `06` §3 warns about.** What §3 forbids is a
benchmark quietly tuning the mechanism it scores. The defence is not abstaining from ever
acting on a measurement — an experiment nobody is allowed to act on is not an experiment.
The defence is the *order*, and that it is visible: U13 measured, published the sweep, and
deliberately shipped the worse row (0.08 rather than 0.00) rather than move the constant
inside the unit computing the score. The decision was taken afterwards, separately, as its
own act. `summary.md` publishes the sweep, the old value, the new value, and the fact that
one followed the other, so a sceptical reader can reconstruct the sequence rather than
take it on trust.

**Two things this cost, both accepted.** The end-of-day-two gate table is republished, and
the 0.28 run is **deleted rather than kept alongside** — two published tables in one
repository make a reader guess which one is quoted, and the prior figures survive in V20,
in U13's entry and in this file. And `scripts/bench-results.mts` needed a second honest
paragraph for the case where the arm *is* at zero: the old text explained "why the CORTEX
arm is not at zero", which over a zero would have been a placeholder in prose form.

**One bug this turned up, worth naming because it is the same class.** The first draft of
that new paragraph read the count of pairs caught by the old threshold off
`DEFAULT_DEDUPE_THRESHOLD`, and so published "it shipped at 0.28, where it caught 6 of 6"
— true of 0.39, false of 0.28, and it would have re-described history every time the
constant moved. The historical number is now a fixed named constant. A generated document
that derives a claim about the past from a value that lives in the present will lie the
first time the present changes.

## 2026-08-11 — `cortex_demo` is confined by row-level security, in the one cluster

`04` §3 left open how the demo principal is confined, between a dedicated demo cluster
and demo-scoped `repo_id`s in the one cluster. The stated objection to the second was
that confinement would then rest on the write path rather than on the account boundary,
and §3 is explicit that real repository memory must be **unreachable to the principal**,
not merely filtered out of its queries.

**Row-level security removes the objection**, which is what made the choice easy once it
was measured rather than reasoned about. The predicate is attached to the principal by
the database. `cortex_demo` holds ordinary DML on the six tables, every table carries
`FORCE ROW LEVEL SECURITY`, and every policy admits only rows whose repository is an
unexpired demo scope and is the scope this connection named. A wrong statement from a
correct application, or any statement from a compromised one, still cannot reach a real
repository — `demo_expires_at IS NOT NULL` is false for every one of them.

The dedicated cluster was rejected on the risk it adds rather than the isolation it
gives: `08` §7 already ranks a paused free-tier cluster as the most likely way this
submission fails *after* submission, and a second cluster doubles that surface for
something RLS provides inside the one. It would also have made the one-cluster claim —
which is the thesis — false.

**Three things this decision had to learn from the cluster, none of which were guessable:**

1. **Policy expressions cannot contain a subquery.** `EXISTS (SELECT 1 FROM repos …)`
   returns 42P01 and `IN (SELECT id FROM repos …)` returns 42703; the expression is
   parsed against its own table and no other data source is in scope. A `STABLE`
   function is the way through, and it reads better anyway. It cannot be `LEAKPROOF`,
   which this cluster requires to be `IMMUTABLE`.
2. **`CREATE POLICY IF NOT EXISTS` silently skips.** Adding the session condition to
   already-created policies applied perfectly to a fresh cluster and changed nothing on
   the live one, with the migration reporting success. Every policy is now
   DROP-then-CREATE. A migration must converge, not merely avoid erroring — and the
   failure mode of the weaker form is a green run over an unchanged database.
3. **`FORCE`, not `ENABLE`.** `ENABLE` exempts the table owner, and the owner runs the
   migration. Without `FORCE` the policies would be inert exactly where nobody looks.

**What is deliberately claimed narrowly.** Session-versus-session isolation is enforced
by a per-connection setting, so it is defence at the write path and not at the account
boundary — every visitor connects as the same SQL user, and there is no SQL role per
anonymous visitor. It is worth having because it **fails closed**: unset, the predicate
is false and the demo reads and writes nothing. V5's lesson was that a forgotten scope
filter fails open; this is the same mistake arranged to fail shut. `04` §3 says so in
those terms rather than implying an account boundary that is not there.

---

## 2026-08-11 — The demo session scope binds as a parameter, not as a `SET`

`05` §5 writes the demo write path's scoping requirement literally: "Every route MUST
issue `SET cortex.demo_session = '<session repo_id>'` on its connection before touching a
table." Implemented as written, that interpolates a browser-supplied value into SQL on the
one surface in this project that anonymous strangers reach — invariant 7's exact subject.
`SELECT set_config('cortex.demo_session', $1, true)` reaches the same setting through a
function call, so the value binds, and V26 confirmed against the real cluster that U15's
policies honour it identically.

The decision is not merely "prefer a bind parameter", which needs no decision. It is that
the spec's literal statement was not followed, and the reason is recorded here rather than
left as a silent improvement in `src/db/retry.ts`. What settled it was the mutation:
restoring the interpolated `SET` and running the suite showed the hostile session id
`not-a-uuid'; DROP TABLE claims; --` **reaching the parser and attempting the DROP**,
stopped only by `cortex_demo` lacking that privilege. The application would have passed it
through; a grant caught it. Both layers are worth having and neither is a reason to skip
the other.

`is_local = true` came with it and was worth as much. The setting ends at `COMMIT`, so a
pooled connection returns to the pool unscoped and one visitor's request cannot inherit
another's scope. A non-local `SET` leaks across pooled requests, which the same mutation
also demonstrated by failing the "releases the connection unscoped" test.

## 2026-08-11 — `05` §5's five routes split between U14 and U16, and the line is here

`05` §5 specifies five routes, and both U14 and U16 list §5 among their specs. U14 built
`POST /demo/session`, `GET /demo/state` and `WSS /demo/stream`; `POST /demo/run` and
`GET /demo/sql-log` are U16's.

The split is by what a route is *for*, not by convenience. U14's done-when is "hosted demo
reachable anonymously" and its title is the infrastructure and the change stream, so it
owns the routes that make an anonymous visitor's session exist and stay visible. `/demo/run`
starts a scenario in `replay` or `live` — the scenario is `07` §3's four beats, which are
U16's done-when, and the mode is `04` §5's degradation ladder, which is U17's. `/demo/sql-log`
is the "prove it" panel, and U16's named silent break is that panel printing SQL the system
did not run. Building either inside U14 would have meant U14 deciding what U16's beats are.

Recorded because the alternative reading — U14 builds all of §5 because §5 is in its spec
list — is reasonable, and a later session that re-derives it differently would either build
these twice or leave them for each other.

## 2026-08-11 — The WebSocket connection registry is DynamoDB, not a seventh table

A WebSocket fan-out needs somewhere to keep connection ids between the `$connect` that
mints one and the changefeed event that posts to it. It is not in CockroachDB.

`03` §2 defines six tables and they are the memory model: four tiers plus two identity
tables. A connection id is deployment bookkeeping with a lifetime of minutes, no tenant
meaning, and nothing any invariant in `03` §8 has an opinion about. Putting it in the
cluster would also have meant a seventh table under `cortex_demo`'s row-level security —
policies written for a row that has no `repo_id` and belongs to no scope — which is
ceremony around a value that is not memory. DynamoDB with a TTL attribute is one table,
on-demand billed, destroyed with the stack.

This adds a service `04` §2's deployment table does not list. Recorded here for that
reason; it is an addition to that table rather than a departure from it, and `04` §2's
"no long-lived compute anywhere" is untouched.

---

## 2026-08-12 — Each demo arm runs in its own sandbox scope, and both stay on screen

`07` §2 calls the naive toggle the demo's spine: "same scenario, same cassettes, visibly
different outcome. Contrast persuades; description does not." The obvious implementation is
one session that re-runs, and it is wrong for a reason that only shows up once the mechanism
works: a second CORTEX run in the same scope **dedupes against the first**. That is the
mechanism behaving perfectly and a demo that reads as broken, because the judge sees
`deduped` where the first run showed `granted` and has no way to know why.

So each arm gets its own scope, and both results stay on screen side by side rather than
replacing one another. The second half matters as much as the first: a toggle that swaps the
view makes the contrast depend on the judge's memory of a screen they are no longer looking
at, and `07` §1 gives them ninety seconds and no patience. Two columns of numbers ask nothing
of them.

## 2026-08-12 — The meter quotes the benchmark for tokens, and labels it

`07` §2's meter lists "tokens saved". The demo scenario spends no reasoning tokens — it
embeds and arbitrates, it does not reason — so there is no token figure this session could
honestly display, and `07` §1 requires every number on screen to be real.

Three options were live: omit the row, show TBD, or quote the benchmark. The row is quoted
from `bench/results/2026-08-10T22-38-54-176Z` — `wasted_tokens` 4000 naive against 867
CORTEX — under an explicit "measured in the benchmark over 30 tasks, not in this session"
label. That number is real, published, and reproducible from a clean clone; what would have
been dishonest is letting it read as this run's, which the label prevents.

TBD was rejected for this surface specifically. The rule against placeholder numbers exists
so that nobody writes a plausible fiction, and TBD is the right answer in a results file
where the reader is auditing. On a judge-facing panel it reads as unfinished rather than as
rigour, and there is a true number available to show instead.

## 2026-08-12 — The naive arm's shared state is a JSONB column on `repos`

U16b §3b required the NAIVE arm to perform its work against the database and lose it for
real, and left the shape of the shared artifact to be decided and recorded. It is
`repos.demo_shared_state JSONB`, added `ADD COLUMN IF NOT EXISTS` on U15's precedent.

`06` §2 specifies "shared state: JSON file on disk, last-write-wins" for this arm, and
`bench/arms/naive.ts` already implements exactly that against a real file. The demo needed
the same mechanism against a row, so the column is one whole cell that each agent reads,
holds while it works, and writes back entire — because the whole-artifact rewrite *is* the
loss, and a row per entry would be an append that loses nothing.

The two alternatives U16b offered were a reserved fact key in `findings`, and a new table.

`findings` was rejected on two counts. It requires a `VECTOR(1024)` that a work log has no
meaning for, and a fake finding would surface in the demo's own semantic-memory panel — the
naive arm's shared file appearing as CORTEX-shaped memory is precisely the confusion the
toggle exists to remove. `intents` fails the same way. A seventh table was not considered
seriously: `03` §2's six are the memory model and U16b says to stop and ask before adding
one, and this is not memory — it is the thing the naive fleet uses *instead* of memory.

`repos` is where a demo session's own demo-only state already lives (`demo_expires_at`,
U15), it is one row per session, it carries the same row-level security policy as
everything else so confinement is unchanged, and — the load-bearing detail — **it is not in
the changefeed's watch list**, so the naive arm writes real rows without manufacturing
change events for a panel that has nothing to render them in. No changefeed recreation was
needed.

It does not consume the `03` §7 row budget, which counts the five tenant tables and
deliberately not `repos`. That is consistent: the cell is part of the session's own scope
row, like its expiry, not something the session spent its budget on.

## 2026-08-12 — Beat 3 is a real race; beat 2 is deliberately still a sequence

U16b §3a asked for the five agents to run concurrently. Beat 3's two do. Beat 2's two do
not, and the distinction is not a shortcut.

Dedupe is a **temporal** relationship. `07` §3 beat 2 is "agent-4 declares an intent worded
differently from agent-2's **in-flight** intent" — a later agent discovering that its task
is already underway. Two agents proposing in the same instant on the same key is not a
dedupe at all: arbitration correctly grants one and blocks the other, which is beat 3.
Racing beat 2 would not have made it more honest, it would have deleted it and left the
demo with two copies of beat 3.

Contention is a **simultaneous** relationship, and beat 3 is where `07` §3 says "in the same
instant" — the one word in that table that was not true until now. Both proposals are in
flight at once on their own pooled connections, the unique index on
`(repo_id, resource_key)` decides, and nothing in `src/demo/scenario.ts` may assume which
one wins. `SCRIPT.claimWinner` and `SCRIPT.claimLoser` were renamed to `contenderA` and
`contenderB` for that reason: a name that turns out false on half the runs is worse than a
dull one. `test/scenario.test.ts` asserts that exactly one is granted and that the blocked
one names *the other*, never which.

## 2026-08-12 — An agent that exhausts `03` §5's five attempts re-plans once, and the retry helper is not touched

Genuine concurrency made SERIALIZABLE conflicts routine for the first time in this project,
which is what U16b §3a predicted and wanted. It also made the five-attempt cap reachable:
measured at roughly **one run in twelve** for beat 3's pair, both agents exhausting
together (V30). The naive arm's four concurrent writers on one row did not exhaust it once
in twelve.

An exhausted 40001 used to escape `runScenario`, reach `infra/lambda/demo.ts`, and become a
503 reading "The demo backend could not reach its database" — which is an error page on the
path behind the run button, forbidden by `04` §5 invariant 1, and false besides: the
database was reached and the transaction gave up.

The fix is `replanOnce` in `src/demo/scenario.ts`, and it is `03` §5's own instruction
rather than a workaround for it. §5 caps the helper at five and says why in its next
bullet: "losing fast and re-planning is the desired behaviour; blocking turns the fleet
into a queue." An agent that exhausts the cap has lost fast; what it does next is re-plan,
and for an agent whose plan is one proposal that means proposing again. It does so once,
and the step carries `replanned: true` so the panel says it happened. A second exhaustion
is reported as `contended` — an outcome, never an exception.

**Escalated to Julian, and decided by him the same day.** The underlying cause is that
`backoffMs` slept 20–320 ms while a propose transaction against CockroachDB Cloud takes
about a second, so two agents that collided restarted into each other. The two candidate
fixes were a larger `BASE_DELAY_MS` and full jitter, and both change the mechanism *every*
write path in this project depends on (invariant 6) on the strength of one demo. Full jitter
additionally overturns a documented, tested property — `src/db/retry.ts` states that the
jitter window is deliberately narrower than the gap between attempts so successive delays
cannot overlap, and `test/retry.test.ts` asserts it over 200 draws. That made it his call
rather than U16b's.

**He chose the larger base delay, measured (2026-08-12, V31): 20 → 250ms.** The same 12-run
probe, in isolation before and after, went from `threw 1/12 · retries 0,1,8,1,1,1,6,1,1,1,1,1`
to `threw 0/12 · retries 0,1,1,1,1,1,1,1,3,3,1,1`. Every documented property survives because
each is stated relative to the constant, so `test/retry.test.ts` needed no edit at all — which
is the argument for that test having been written against `BASE_DELAY_MS` rather than against
literals in the first place. `replanOnce` stays regardless: it is `03` §5's own instruction,
and it is what keeps an exhausted agent an outcome rather than an exception.
