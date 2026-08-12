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
from `bench/results/2026-08-12T18-35-38-014Z` — `wasted_tokens` 4000 naive against 867
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

## 2026-08-12 — `03` §4.1's recall threshold closes at `0.60`, chosen from a sweep

`03` §4.1 publishes `WHERE n.dist < 0.35` and `src/memory/recall.ts` shipped it. V28 measured
that under real Titan embeddings every honest wording of a finding sits 0.38–0.47 from the task
it describes, so the filter excluded exactly the case recall exists to serve, and the demo's
beat 1 reported "nothing known" truthfully for two days. `docs/SPEC-DELTA.md` recorded it and
**declined to patch it**, because moving a mechanism constant so the demo showcasing the
mechanism looks better is the circularity `06` §3 exists to prevent.

The precedent for closing it was `03` §4.2's dedupe threshold: sweep first, publish the table,
and let Julian choose with the measurement in front of him. That is what happened here.
`npm run sweep:recall` and
`bench/results/2026-08-12T18-35-38-014Z/recall-threshold-sweep.md`, V33.

**Why 0.60 and not the smaller number that would also have worked.** Beat 1 fires at anything
from 0.39 up, because its seeded finding sits 0.3801 from its query. Choosing 0.39 would have
been choosing the *minimum value that rescues the demo* — the circularity arriving in a
different coat, and it is also the dedupe constant, which CLAUDE.md already forbids sharing.
0.60 was chosen by a criterion that is a property of the corpus and would select the same value
with no demo in existence: **the largest tested threshold that returns nothing irrelevant.**
Precision 1.000, 6 of 8 queries served where 0.35 served 1. The first false positive is at 0.63.

**The argument that makes this not circular at all** was written down on 2026-08-11, before
anyone knew beat 1 depended on it. Recall at 0.35 was *tighter* than dedupe at 0.39, and that
ordering is backwards on the meaning of the two tests: answering yes to dedupe **cancels an
agent's task**, so a false positive destroys work that needed doing; answering yes to recall
**adds a line to a context window**, so a false positive costs attention. The test with the
expensive error must be the strict one. Dedupe tighter, recall looser.

**What was rejected.** Leaving 0.35 and writing disclosure copy on the SPA so the empty recall
read as a stated limitation rather than a bug. That would have been honest, and it was on the
table as an explicit option. It was rejected because the ordering above says 0.35 is wrong on
its own terms — disclosure would have documented a defect instead of fixing one.

**What this decision does not claim.** The sweep's hard negatives did not land close under
Titan — FI4a, written as the vocabulary trap for "add a retry to the orders client", sits at
0.6825, further out than a finding that was not designed as a trap at all. So the precision
column is optimistic and the sweep bounds this constant **from below** rather than proving a
ceiling. A harder corpus would break precision earlier than 0.63 and this number would come
down. That is stated in the published sweep, not only here.

**Three consequences worth recording, because two were nearly missed.**

1. **The constant had a second literal.** `bench/arms/shared.ts` defined its own
   `RECALL_MAX_DISTANCE = 0.35` for the NAIVE arm's local store, while the CORTEX arm inherited
   `DEFAULT_MAX_DISTANCE` by calling `recall()` with no override. Moving one and not the other
   would have given one arm a wider memory than the other and called the difference a
   coordination result — `06` §3's circularity arriving by accident. It is now a re-export, so
   the two cannot diverge.
2. **The skill publishes the number and the byte-for-byte pin could not see it.** `$4` is a
   parameter, so `RECALL_SQL` is identical at every threshold and `test/skill.test.ts`'s
   equality assertion passes regardless. A stale `0.35` in `skills/cortex-memory/SKILL.md` would
   have shipped a narrower memory to the one audience that cannot check it against the source.
   There is now an assertion holding the published value equal to the constant.
3. **The benchmark did not move, and the reason corrects an older claim.** Every `06` §3 metric
   is identical at 0.60 and 0.35. Nothing populates `findings` in that harness — it runs no
   changefeed — so recall returns 0 rows at any distance. The published limitation used to say
   the cause was that consolidation is "not built"; V27 built it. The cause is a harness
   boundary, and it was never the threshold. Results were republished with the corrected text.

---

## U17 — `04` §5 brake 2 gets a seventh table, and the LIVE cap ships at 10 rather than 40

**2026-08-12. Julian's calls, both taken with the measurement in front of him.**

`04` §5 requires "a run counter in CockroachDB, default 40 LIVE runs per day globally". Two
things had to be decided before a line of it could be written, and both were flagged as
stop-and-ask by U16b and by `CLAUDE.md` rather than taken inside a unit.

### Where the counter lives: a new table, `live_run_budget`

`03` §2's six tables are the memory model, so a seventh is a schema decision and not a
detail. Three options were put up.

**Chosen: a new table with its own narrow policy.** It is the only one of the three that can
hold a *global* counter — and global is the operative word, because every anonymous visitor
mints a fresh session scope, so a per-scope counter would cap nothing at all. A scripted
visitor would simply ask for another session.

**Rejected: a singleton row on `repos`.** No new table, but `repos`' policy is the one every
other table's `is_current_demo_scope()` depends on, and exposing a non-demo row through it
widens the blast radius of U15's entire confinement to save one `CREATE TABLE`.

**Rejected: DynamoDB**, where the connection registry already lives. It needs no schema
change at all, and it is wrong on three counts: `04` §5 says "in CockroachDB"; it cannot be
read in the same transaction as anything else, so the cap becomes advisory; and it moves a
load-bearing mechanism out of the database this submission's whole argument is about.

**The exception this creates, stated plainly.** `cortex_demo` now reaches one row that is not
in a demo session scope. It is bounded to *today's* row by the policy `day = current_date`,
and there is no DELETE grant — a principal that can drop today's row can reset the brake that
governs it. Earlier days are invisible, unwritable and unremovable, and
`test/privilege-planes.test.ts` attempts all three rather than trusting the grant list.

Invariant 5 is the other thing this table sits outside, and it is the reason the table holds a
date and a count and nothing else. The invariant protects tenant memory from a forgotten
filter; there is no tenant here to leak. That is a claim about the schema, so
`test/live-budget.test.ts` asks `information_schema` — if a later unit adds a per-session
column, the exemption fails loudly instead of quietly widening.

### The cap: 10 a day, not §5's 40

§5's own budget for the project is "single-digit dollars for the whole hackathon and judging
period", and until this unit nobody could hold the two numbers against each other, because the
Bedrock rate for Sonnet 4.5 was TBD. It is no longer. **See V36 for how it was obtained** —
briefly: AWS's pricing page failed twice (V30), the machine-readable Price List API does not
carry the model at all, and the number came from this account's own billing records, where
`Claude Sonnet 4.5 (Amazon Bedrock Edition)` is a **service of its own**, separate from
`Amazon Bedrock`, at **$3.30 per 1M input tokens and $16.50 per 1M output**.

Against the committed cassettes (30 calls; input 320/500/1067, output 59/72/111), a five-agent
run costs $0.0142 typically and $0.0268 at the observed maximum. So §5's 40 runs a day is
$0.57–1.07 a day and **$19–36 through 2026-09-15** — §5's stated default breaks §5's stated
budget. Ten a day is $4.83–9.10 over the same window: the largest round cap whose worst case
stays single digit.

**What was rejected:** shipping 40 and recording the tension. Credits currently absorb the
whole bill — the usage line and an offsetting credit line are equal and opposite today — so
the real exposure is $0 and 40 would cost nothing *this week*. It was rejected because the
demo has to stay up until 2026-09-15 and "the credits will hold" is not something this
repository can assert. The deviation from §5's published 40 is in `docs/SPEC-DELTA.md`.

There is deliberately **no environment variable** for the cap, for the reason `05` §6 removed
`CORTEX_DEDUPE_THRESHOLD`: a deployment running a number the published evidence does not
describe has un-closed the decision without a commit.

### A slot is spent when it is granted, not when the run succeeds

`docs/UNITS.md` asked for the counter to be checked and incremented "in the same transaction
as the run it authorises". There is no such transaction: a demo run is deliberately many
transactions and several of them are concurrent with each other (`07` §3 beat 3 is a real race
between two). What that clause protects is the race between two visitors, and that is closed.

The consequence is that a run which dies after taking its slot has still spent it. That is the
safe direction and it is chosen: the other ordering lets a failing run spend Bedrock tokens and
then hand the slot back, which is the shape of a cap that can be exceeded by failing.

---

## U21 — abandonment becomes memory, and a finding is embedded on the work rather than the obstacle

**2026-08-12/13. Julian's calls, both taken from measurements that contradicted the obvious
answer.** These came out of a demo question — "what do the agents actually do?" — and turned
into two mechanism findings.

### An abandoned intent's knowledge reached nobody

The fleet demo wanted a moment where one agent burns tokens discovering a task is impossible
and a **second agent is spared**. It could not be built: an abandoned intent is excluded from
consolidation (`03` §4.4), from the changefeed sink, and from `findDuplicate`'s candidate set
(`03` §4.2's own SQL). Its `abandonReason` was written down and reachable by no one.

**Decided: `done` and `abandoned` both consolidate.** The argument is that §4.4's grouping is
wrong rather than that the demo is inconvenient — `proposed` and `in_flight` are unfinished,
`deduped` is work that deliberately never happened, and an abandoned intent is the only one of
the four that is a **concluded outcome**. It is also the most expensive knowledge a fleet
produces, because an agent spent tokens getting it, and the system was keeping the cheap
successes and discarding it.

**Rejected: adding `abandoned` to the dedupe candidate set.** It would have delivered the
prior outcome directly through invariant 4, with no embedding round trip and no recall
threshold to clear. It is refused because "someone gave up" is not evidence that work is
impossible, and deduping on it turns a hint into a veto. The measurement sharpens the point:
the three candidate wordings of the task this exists to save sit **0.3649–0.3778** from A1's
own statement, inside the 0.39 threshold, so they would be silently cancelled.

**Rejected: building the moment from a `reverted` task instead.** It needs no mechanism change
at all — `reverted` maps to `done`, consolidates, and is recallable, which is exactly how the
fourteen-day-old seed already works. Refused because it says the same thing the seed already
says, and because it would have left a real gap in the memory model unexamined.

**The changefeed sink's copy of the rule was deleted rather than updated.** It tested
`status === 'done'` while `consolidateClosedIntent` applied the same rule again — the same
decision in two files, one deployed separately from the other. The sink's copy would have
silently vetoed abandonment while the unit test passed, because the test calls the function the
sink was shadowing.

### The careful agent produced a finding nobody could find

With abandonment consolidating, the eleventh task still did not work. Three wordings of it
measured **0.6725–0.7246** from A1's abandonReason, outside recall's 0.60. The bare fallback
`"<statement> — abandoned"` measured **0.4698–0.4899** and was retrieved by all three. Both in
one sentence: 0.6022–0.6090, missing by two hundredths.

An abandonment note names the **obstacle**; the agent who needs it names the **work**. So the
system as built had the property that **an agent which explains itself carefully produces
memory nobody can retrieve, while one that says nothing produces memory that works.**

**Decided: separate the retrieval key from the stored fact, for abandonment only.**
`consolidate()` already took `fact` and `embedding` as separate arguments, so this is a seam
that already existed — `retrievalKeyFromClosedIntent`. The finding now reads as the reason it
failed and is found by the work it concerns.

**Rejected: authoring the demo's agent to leave no notes.** It ships today, needs no change,
and lands at 0.4698. Refused because it optimises the demo around a defect instead of fixing
it, and bakes in the property above.

**Rejected: applying the change to every closed intent.** Arguably more correct, and it would
make recall behave consistently — but V28 measured the demo's seeded finding at 0.3801 from
its task precisely because the *note* is embedded, and beat 1 fires on that number. Widening
this needs the recall corpus re-measured first, which is not a thing to do four days before
ship.
