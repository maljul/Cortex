# Spec delta

Places where `spec/` no longer matches what the repository does or knows. Recorded
here rather than silently reconciled in code — three spec claims have already been
falsified this project (V1 opclass, V5 index isolation, Bedrock v5 entitlement), and
every one read as obviously true until it was invoked.

An entry leaves this file when the spec is corrected, not when someone works around
it. Entries already corrected in the spec are noted at the bottom so the correction
is not undone by a later reader.

---

## Open

### `07` §4's mode line claims cached reasoning that does not happen *(2026-08-12, U16)*

§4 requires "an always-visible line in REPLAY: `replay mode: agent reasoning is cached, all
database behaviour is live`". The second clause is true. The first is not: the demo scenario
performs **no model reasoning at all**. It embeds statements via Bedrock Titan — live calls,
not cassettes — and every decision on screen comes from `propose`, `close`, `recall` and
`consolidate`, none of which reasons about anything.

Shipping §4's wording verbatim would assert a cache that does not exist, on the one page a
judge reads, in the sentence whose entire purpose is honesty about liveness. `07` §4 itself
says never to narrate replay footage as live inference; the same rule read backwards forbids
narrating live behaviour as replayed. The deployed line is:

> **live database, live embeddings** — Every row on this page was committed by CockroachDB
> and arrived over its own changefeed. Dedupe distances come from live Bedrock embeddings.
> This scenario performs no model reasoning, so nothing here is replayed from a cassette.

It is served from `GET /demo/state`'s `mode` block rather than written into the markup, so
the page cannot claim a liveness the backend is not reporting.

**Closes when the scenario gains a LIVE reasoning step.** That belongs with U17, which owns
`04` §5's quota rungs, and U19, which records in LIVE mode. At that point REPLAY becomes a
real second value, §4's wording becomes accurate, and this entry is deleted rather than
amended. `test/demo-plane.test.ts` asserts the deployed reason never says "reasoning is
cached", so the wrong line cannot come back quietly.

### `03` §4.1's `dist < 0.35` is tighter than real embeddings reach, so recall returns nothing *(2026-08-11, V28)*

§4.1's published SQL filters findings at `WHERE n.dist < 0.35`, and `recall()` ships that
as `DEFAULT_MAX_DISTANCE`. Measured against **real Titan embeddings**, a finding about a
task sits further from that task's statement than 0.35, so the filter excludes exactly the
case recall exists to serve.

Query: `add a retry to the orders client`. Candidate findings, every one of them an honest
wording of what an agent would record after doing that work:

```
0.3801  adding a retry to the orders client broke 429 handling and was reverted
0.3852  orders client retry: skip 429
0.4166  a retry in the orders client must skip 429 — retrying it drops the order
0.4218  the retry added to the orders client dropped orders on 429 and was reverted
0.4271  retry in the orders client — reverted, it dropped orders on 429
0.4680  the orders client retry loop drops the order when the server answers 429
```

Nothing clears 0.35. The closest is 0.3801 and it reads well; the wordings *below* 0.38
stop sounding like findings and start sounding like restatements of the task.

**This partially corrects U12's diagnosis.** U12 recorded that CORTEX recall returns 0 in
the benchmark and attributed it to consolidation not being built. Consolidation is built
now (V27) and recall still returns 0 — so the threshold was always a second, independent
cause, and fixing §4.4 alone was never going to move that number.

**Deliberately not changed.** Moving a mechanism constant so that the demo showcasing the
mechanism looks better is the circularity `06` §3 exists to prevent, and the precedent is
`03` §4.2's threshold: swept, published, and closed by Julian as a separate act with the
measurement in front of him. The demo reports "nothing known" when nothing is known, which
is `07` §4's honesty rule working as intended.

**What closing it needs:** a sweep like `bench/results/*/threshold-sweep.md`, over findings
and queries rather than over intent pairs. Note that 0.35 is currently *tighter* than the
dedupe threshold of 0.39, which is the wrong way round on the face of it — recall asks
"what might be relevant", dedupe asks "is this the same work", and the second is the
stricter question. Whoever sweeps this should say why the ordering is what it is.

### `04` §5 brake 1 — reserved concurrency cannot be set on this account at all *(2026-08-11, V26)*

§5 requires three independent brakes on LIVE mode and lists first: "**Reserved
concurrency of 2** on the LIVE Lambda. A traffic spike physically cannot fan out."

It is not implementable here. AWS refuses any reservation that drops the account's
unreserved concurrency below 10, and this account's *total* limit is 10:

```
$ aws lambda put-function-concurrency --function-name …IdentityFn… \
    --reserved-concurrent-executions 2
InvalidParameterValueException: Specified ReservedConcurrentExecutions for function
decreases account's UnreservedConcurrentExecution below its minimum value of [10].
```

Every value from 1 upwards is refused, so this is not "reserve less" — the mechanism is
unavailable. It compounds V22 rather than repeating it: V22 found the pool small and
unraisable from the CLI, and this finds it **indivisible**, so no function can be given a
floor or a ceiling relative to the others.

**Nothing was substituted in U14.** The stack carries no reservation on any function and
says so in `infra/cdk/lib/cortex-stack.ts`, where the concurrency budget is written down
as §5 asks. Choosing a replacement is `04` §5's decision to re-make and U17's to force —
that unit already owns the ladder, already has to absorb overflow at 10, and already has
to build a fifth rung for concurrency exhaustion. Picking a brake inside U14 would have
been a §5 decision taken by the unit least equipped to verify it.

The two remaining brakes are unaffected: the run counter in CockroachDB is application
state, and an AWS Budget alarm targeting the LIVE function is unrelated to concurrency.

### `03` §7 — demo rows are unreachable on expiry but are not reclaimed *(2026-08-11, U14)*

§7 requires that "demo rows MUST carry a TTL and be reclaimed automatically. No manual
cleanup between now and 2026-09-15." Half of that is built and the half that is missing
is the cheaper half, which is why this is recorded rather than quietly counted as done.

**Unreachability is enforced and tested**: `repos.demo_expires_at` is checked by the
policy predicate at read time, so a scope goes dark the instant it passes, before any job
runs (`04` §3 relies on exactly this, and `test/demo-stream.test.ts` asserts it by letting
a one-second session expire). **Reclamation is not built.** `claims` has a row-level TTL
from U1; `intents`, `findings`, `action_ledger`, `agents` and `repos` do not, so an
expired demo scope's rows sit there permanently invisible.

Not fixed inside U14 on purpose: a blanket row-level TTL on those tables would apply to
**real repository memory too**, and `03` §7 says `findings` never expires. The correct
shape is a TTL predicated on the scope being a demo scope, or a sweep that deletes where
`demo_expires_at < now()`, and either is a `03` §2 schema decision rather than a
deployment detail. `03` §7's own budget line — "the demo dataset MUST stay under a few
hundred megabytes" — is what makes this eventually matter; at demo volumes it does not
matter yet, and the security boundary does not depend on it.

### `08` §4 and `05` §2 name `cortex bench`; the command is `npm run bench` *(2026-08-10)*

U12's done-when is "`cortex bench` runs both arms deterministically", and `05` §2 puts
`bench` in the `npx cortex <command>` table. **There is no `cortex` binary.** The CLI is
U2, deferred to day three with the rest of the onboarding surface, so the harness ships
as `npm run bench` alongside `npm run gate:contend`, `npm run db:check` and the other
scripts that would each be a `cortex` subcommand.

Recorded rather than papered over: adding a `bin` entry to `package.json` pointing at a
TypeScript file would make `npx cortex bench` work on this machine, where `tsx` is
installed, and fail on the clean clone `06` §5 is written about. That is a worse lie
than a differently-named command, and the flags (`--arm`, `--seed`, `--tasks`,
`--record`, `--json`) are already the shape `05` §2 asks for, including `--json`.

**Closes when U2 lands.** `cortex bench` should then delegate to the same `runArm`, and
the README must publish whichever name actually works, because §7.1 requires the exact
reproducing command.

### `06` §3 — two metrics cannot mean what §3 implies under a reproducible harness *(2026-08-10)*

§5 requires the re-run to be reproducible; U12's scheduler achieves that by running one
step at a time on a simulated clock (`docs/DECISIONS.md`, V19). Contention is real and
deterministic, but two transactions never overlap, so:

- **`serialization_retries`** is 0 by construction. §3 defines it as a "count of `40001`
  retries", which reads as a property of the mechanism under load; measured here it is a
  property of the harness.
- **`claim_p50` / `claim_p95`** are uncontended arbitration latencies, not the queueing
  behaviour the percentile pair suggests.

Not a spec error so much as a place where §3 and §5 pull against each other, and §5
wins because a benchmark whose figures move between runs is worth nothing. §3 would be
better with a sentence saying which of its metrics are harness-dependent. The real race
is evidenced separately by `npm run gate:contend` (U6) and V13.

### `06` §5 — "both arms consume the same cassettes" is true of the library, not the draws *(2026-08-10)*

§5: "Both arms consume the **same cassettes**. Any difference in results is therefore
attributable to the coordination layer and nothing else." Read strictly that is false of
any working implementation, and the reason is the mechanism itself: the CORTEX arm does
not reason about a task it dedupes, so it draws *fewer* reasoning cassettes than NAIVE.
That gap is the saving being measured.

What holds, and what `test/bench-runner.test.ts` asserts instead: both arms embed every
task they attempt, so the embedding sets are **equal**; and CORTEX's reasoning keys are a
strict **subset** of NAIVE's, which covers all 30 tasks. Same library, fewer draws — the
attributability §5 wants, stated in a form that can be checked.

### `11` §2 and §6 — the six-command ship loop is now three commands

§2 specifies `lh-next.md`, `lh-work.md`, `lh-gate.md` and `lh-log.md`, and §6 adds
`lh-fix.md`, with §5's driver sequence written as
`/lh-next → /lh-work → /lh-gate → /lh-log`. `.claude/commands/` now holds `go.md`,
`check.md` and `ship.md`. `/go` absorbs next + work + log, `/check` absorbs gate + fix,
`/ship` is the former `lh-ship.md` renamed.

Nothing in §2's content was dropped — the four-item unit preamble, the transaction
boundary statement, the DECISIONS.md `[OPEN]` step and the spec-error-goes-to-delta
rule were folded into the surviving two commands, and `/check` gained rows for
invariants 5 and 6 that no command previously had. The `lh-` prefix is dead naming from
before the project became CORTEX.

Since then the four purely mechanical rows of the gate — typecheck, SQL containment,
`.env` ignored, credentials — have left the prompt entirely for
`scripts/gate-mechanical.sh`, which `/check` calls with `--report` and a PreToolUse
hook calls on every commit made through Claude Code. §2 assumes the gate is a prompt
an agent reads; four of its rows are now a process that exits 2.

**Edited in the spec 2026-08-10.** §2 now opens with a superseded banner giving the
current command set and the mapping, §3's driver sequence reads `/go` then `/check`,
and the stale `/lh-gate` references in Cadence and the Escape hatch are corrected. The
command prose under §2 is deliberately kept: it is where the reasoning for each step
lives, and it is labelled as reasoning rather than as something to type.

§5's `/clear` discipline — fresh context before working a unit and again before gating
it — is unchanged and remains the load-bearing part. This entry stays here rather than
under Corrected because the drift it records is not fully closed: §2 still describes a
gate that is a prompt an agent reads, and four of those rows are now a shell script
that exits 2.

---

### `05` §1 and `03` §4.2 name the same decision fields differently *(§1 completed 2026-08-10)*

**Half closed.** §1's `Decision` type was missing `status` and `distance` on a dedupe
and `expiresAt` on a contested key — fields `cortex_propose` has returned since U8.
§1 now lists them, with a note on why `expiresAt` in particular is not decoration: it
is how a blocked agent chooses between re-planning and coming back.

The naming difference itself is **not** reconciled, deliberately, and stays open below.

§1 types the value an agent receives as `{ decision: 'deduped'; ofIntentId; holder;
outcome }` and `contested: Array<{ key; holder; intentId }>`. §4.2's application rule
writes the same value as `{ decision: 'deduped', of, holder, outcome }`, and the SQL
it returns names the column `resource_key`. Neither section acknowledges the other.

Both are honoured, in the place each is about. `src/memory/propose.ts` kept §4.2's
names because it *is* §4.2's transaction. The MCP boundary answers in §1's, because
§1 is where the shape an agent codes against is written down, and U10's Agent Skill
will tell agents how to react to each decision. The translation is six lines in
`src/mcp/server.ts` and is the only place the two vocabularies meet.

§1's `Decision` was also incomplete rather than wrong — no `distance` or `status` on a
dedupe, no `expiresAt` on a contested key, all three of which the tool returns and
none of which it renames. **That half is fixed as of 2026-08-10; §1 lists them.** The
last one was never cosmetic: without it a blocked agent knows who holds the key but
not for how long, which is what decides between re-planning and waiting, and invariant
3 exists to make that judgement possible.

## Corrected in the spec already — do not re-open

### `05` §6 documented `CORTEX_DEDUPE_THRESHOLD` and nothing read it *(closed 2026-08-11 — removed)*

**Closed by deleting it from §6**, which now says explicitly that the threshold is not
configurable at run time and why.

The reasoning, which is the part worth keeping: `03` §4.2's value was closed at 0.39 on a
published sweep, with the sweep, the previous value and a re-run benchmark all committed
under `bench/results/`. An environment variable that silently overrode the constant would
let a deployment run a number the published evidence does not describe — un-closing that
decision without a commit and without a re-run. Wiring it up was the other available fix
and was rejected for that reason, not because it was harder.

The original finding: §6's configuration block listed it, so a reader took it for a
supported knob. The only consumer of the threshold was `DEFAULT_DEDUPE_THRESHOLD` in
`src/memory/propose.ts`; `propose()` accepts an optional per-call `dedupeThreshold`, and
nothing filled it from the environment — not `src/mcp/server.ts`, not the bench arms, not
the scripts. A documented knob that does nothing is the same class of defect as a comment
asserting an invariant no test checks: someone sets it, observes no change, and goes
looking for the bug somewhere real.

### `03` §4.2 — `DEDUPE_THRESHOLD` was 0.28, below the band the corpus needs *(closed 2026-08-11 — 0.39)*

**Closed 2026-08-11 at `0.39`.** `03` §4.2 now states the value, the band it came from,
and the two disciplines the choice had to respect. The benchmark was re-run afterwards
and `bench/results/` republished: CORTEX's `duplicate_work_rate` is 0.00.

The rest of this entry is the original, kept because the measurement is what decided it
and because the *order* — measure, publish, then decide separately — is the part that
keeps the change out of `06` §3's circularity.

§4.2 said the right value was empirical and asked for a sweep. U11 produced the first
measurement, and it said the default was too tight. On the committed corpus, Titan Text
Embeddings V2 at 1024 dimensions:

- worst genuinely-duplicate pair: **0.3630**
- closest combination that is *not* a duplicate: **0.4293**
- so any threshold in **(0.3630, 0.4293)** classifies all thirty tasks perfectly
- at the shipped **0.28**: 4 of 6 pairs caught, 0 false positives

*(At the time of writing:)* The constant in `src/memory/propose.ts` had **not** been
changed. Picking it belonged to U13's `bench/results/threshold-sweep.md`; moving the
mechanism's threshold to fit a fixture is the wrong direction of fit. This was input to
that sweep, not a decision. Numbers and the failed first draft are in V11.

**The sweep exists now (U13, 2026-08-10) and it costs the mechanism a measurable
amount.** `bench/results/<run>/threshold-sweep.md` reproduces U11's band to the digit —
worst declared pair 0.3630, closest undeclared 0.4293 — measured this time by the
offline judge's own distance function rather than by the mechanism's. Precision is
1.000 everywhere up to 0.42 and falls to 0.750 at 0.44.

What the benchmark then measures: at the shipped 0.28 the CORTEX arm's
`duplicate_work_rate` is **0.08, not 0.00**, and the two duplicates the judge finds are
exactly the two declared pairs 0.28 fails to catch. A threshold anywhere in
(0.3630, 0.4293) would take that row to zero with no false positives on this corpus.

It was left unchanged through U11 and U13 for a reason worth preserving: the number that
would improve was the headline number of the benchmark that produced the recommendation,
and making that edit inside the same unit is the circularity `06` §3 exists to prevent.
Waiting cost one published row that was worse than it needed to be, which was the cheaper
of the two mistakes.

### `05` §2 — the Node-versus-Python `[OPEN]` *(closed 2026-08-10 — Node)*

**Closed by Julian, not by drift.** §2 now states Node and gives the reasoning: `npx`
with zero install is on the README's first screen and the benchmark is not, and the
shorter Python path to the embedding code is the weaker side, accepted.

The entry existed because the question had been answered in practice long before it was
answered on paper — every line of `src/`, `bench/`, `scripts/` and `test/` is Node and
TypeScript, and B1 committed the whole tree to one module system with `npx tsc --noEmit`
clean. It was deliberately left open anyway, because closing an `[OPEN]` is Julian's call
and must not happen as a side effect of a build fix. The cost of leaving it, which was
real for a day, was that a reader of §2 could think the question was live and re-open it.

### `04` §3 / `05` §3 — "governed by Cloud RBAC" did not describe the managed MCP server *(resolved 2026-08-10 — the route changed)*

**Closed by decision, not by wording.** Julian chose to drop the managed-MCP read path
rather than try to constrain its principal. Reads are now issued as `cortex_reader`
over `CORTEX_READER_DSN`, whose read-only property `test/privilege-planes.test.ts`
asserts by attempting nine writes and requiring all nine to refuse with 42501.
Reasoning in `docs/DECISIONS.md`, measurement in V17. `CORTEX_MCP_*` survives in `.env`
as diagnostics for `npm run probe:read` and is labelled as such.

**The correction reached five more sections a day later (2026-08-11), and the gap is the
part worth remembering.** The first pass corrected `04` §1, §3, §4 and `05` §3, §4, §6 —
the sections *about* the read path. It missed every section that merely *mentioned* it:
`02` §C (the B10 answer text, which still called the managed server "the agent's **only**
read path" and said `cortex init` prints its config snippet), `03` §4.1's own heading,
`05` §2's CLI table, `07` §5's closing video line, and `08` §4's block description. All
five are corrected in place now, found by grepping the whole of `spec/` for the term
rather than by re-reading the sections that had already been fixed.

`02` §C is the one that mattered: B10 asks what the agent actually *did*, so an answer
describing an abandoned route is a false statement to a judge rather than a stale
document. Its corrected text now carries the measurement as the story — a `SELECT`-only
role with nine attempted writes and nine refusals is a stronger claim than Cloud RBAC
was, and it is one a judge can run.

*(Filed under `04` §2 until this entry was closed; the governance claim actually lives
in `04` §3's privilege-plane table and `05` §3's preamble, which is where the
corrections landed.)*

The original entry, kept because the measurement is what decided it:

§2 routes agent reads through the CockroachDB Cloud Managed MCP Server on the argument
that the agent's read access is then "governed by Cloud RBAC and audit logging rather
than by code you wrote". V10 measured what that server actually offers, and the
argument does not survive contact with it in two ways.

**It is not a read plane.** Of the twelve tools it advertises, three write:
`insert_rows`, `create_table` and `create_database`. Being read-only cannot be a
property of this endpoint, so it has to come from the principal — and §2 does not say
which principal, because the Cloud service account that authenticates to it is an
organization-level identity that `GRANT` does not apply to.

**Its writes reach `claims` and `intents`. Measured 2026-08-10, V17.** This was TBD
until the service account had a role; it now has one, and the answer is the bad one.
The server executes as SQL user `managed-mcp`, which holds INSERT and DELETE on
`claims` and INSERT on `intents`. Confirmed by invoking, not by reading the catalogue:
an `insert_rows` call against `claims` came back **23502** — a NOT NULL violation, the
row rejected — rather than **42501**. The privilege check ran ahead of the constraint
and passed.

So an agent handed this endpoint for recall also holds an unarbitrated write path into
the memory the whole mechanism exists to arbitrate. Every `03` §8 invariant is bypassed
rather than broken: the agent never calls `cortex_propose`, so there is no transaction
to violate.

This was the one entry here that could not be closed by editing wording — either the
spec gained a constraint on the principal that made the claim true, or the read path
was not this server. Two options were put to Julian:

1. **Constrain the principal** — map `managed-mcp` to a `SELECT`-only SQL identity, if
   Cloud exposes that control. Would have kept the argument intact. Whether it is
   exposed at all was itself TBD, and nothing measured suggested the SQL identity is
   configurable, so its best case was arriving where option 2 already stood.
2. **Drop the managed-MCP read path**, serving recall through `cortex_reader` instead.

**Option 2, chosen 2026-08-10.** Reasoning in `docs/DECISIONS.md`.

### `03` §4.1 — the published recall SQL scoped the CTE and not the join *(corrected 2026-08-10)*

**Closed.** §4.1's `LEFT JOIN` now reads
`ON i.id = n.source_intent_id AND i.repo_id = $2`, with a paragraph under the block on
why the query has two `repo_id` predicates rather than one. Settled by Julian the same
day it was found; it was an internal contradiction rather than a design choice, since
§2's design note and invariant 5 both already required the filter.

The original entry, kept because the measurement is what decided it:

§4.1's query is the artifact the project puts on screen, and U10 ships it byte-for-byte
in the Agent Skill. It carried `WHERE repo_id = $2` inside the `near` CTE and then
joined episodic history with `LEFT JOIN intents i ON i.id = n.source_intent_id` — no
`repo_id` on the join.

**It was not theoretical.** `findings.source_intent_id` has no foreign key, so nothing
structural stops a finding in repo A from naming an intent in repo B. Measured against
the cluster on 2026-08-10 (V14): a finding in repo A pointing at a *reverted* intent in
repo B came back from `recall({ repoId: repoA })` with `timesReverted: 1` and a
`lastTouched` date. No text crossed — the join contributes only the two aggregates —
but `ORDER BY times_reverted DESC` is the ordering §4.1 exists for, so the answer repo
A received was computed from a tenant it cannot see.

`src/memory/recall.ts` joins with the predicate and `test/recall.test.ts` fails without
it. Had this stayed open past U10, `SKILL.md` would have pinned the gap byte-for-byte
alongside the query.

### `05` §3 advertised `glob:` keys that §6 gave the server no way to expand *(corrected 2026-08-10)*

**Closed.** §6 now names `CORTEX_REPO_ROOT`, and `cortex_propose` expands a glob
against it — one claim per matched file plus a row for the glob, which is the
structural overlap `03` §3 requires. With the variable unset the tool still refuses,
because a server launched from an arbitrary working directory resolving a glob against
whatever tree it happens to be in is worse than refusing: it returns a plausible key
set for someone else's files.

Mutating the resolver to return no matches — the "claim the bare `glob:` row" shortcut
this entry originally warned about — fails two tests, one of them the double-grant:
a `file:` claim on a path the glob covers is granted rather than blocked.

The original entry, kept because the reasoning is what decided it:

`resource_keys` in §3 documents the grammar as `file:<path>, glob:<pattern>,
migration:<id>, service:<name>:<verb>`, and `03` §3 requires a glob to be claimed as
one row per matched file plus a row for the glob. Matching needs a checkout. §6's
configuration list has no repository root, and an MCP server is launched by an agent
from an arbitrary working directory, so the server has nothing defensible to expand
against.

`cortex_propose` therefore refuses a `glob:` key with a message saying why — reasoning
in `docs/DECISIONS.md`. The gap is in the spec: either §6 gains a repository root, or
§3's description should stop naming `glob:` for this surface. Not fixed here, because
that description is prompt surface pinned verbatim against the spec by a test, and
editing it to match the implementation is exactly the silent reconciliation the
project rule forbids.

### `05` §6 configured the managed MCP server with a URL and no credential *(corrected 2026-08-10)*

**Closed.** §6 now lists `CORTEX_MCP_CLUSTER_ID`, `CORTEX_MCP_API_KEY` and
`CORTEX_READER_DSN`, with a paragraph on what a Cloud service account is and why an
endpoint alone reaches nothing. The names were settled by being used: they are what is
in `.env` and what `scripts/probe-read-plane.mts` reads.

What is **not** closed by that edit is the question behind it, which is still open
above as "`04` §2 — 'governed by Cloud RBAC' does not describe the managed MCP
server". The original gap, for the reasoning:

§6 lists `CORTEX_MCP_ENDPOINT # https://cockroachlabs.cloud/mcp` and nothing else for
the read plane, which reads as though the endpoint were all that is needed. It is not.
The CockroachDB Cloud docs give the client configuration as:

```json
"cockroachdb-cloud": {
  "url": "https://cockroachlabs.cloud/mcp",
  "headers": {
    "mcp-cluster-id": "{your-cluster-id}",
    "Authorization": "Bearer {your-service-account-api-key}"
  }
}
```

So two values are missing from §6: the cluster id, and an API key belonging to a Cloud
**service account** — which is a Cloud-level identity created in the Console, distinct
from the SQL users `04` §3 talks about. §6 names no configuration key for either, and
U10 cannot be started without them.

Not invented here. The names `CORTEX_MCP_CLUSTER_ID` and `CORTEX_MCP_API_KEY` are
proposed to Julian and go in `.env` only; §6 should gain them once they are settled.

**A second, larger gap behind it.** `04` §2's argument is that reads go through the
managed server so the agent's read access is "governed by Cloud RBAC" — but the docs
retrieved say Cloud roles and SQL roles are managed independently and that `GRANT`
does not apply to Cloud roles. Which SQL identity the managed server executes as, and
therefore whether `cortex_reader`'s `SELECT`-only grant governs it at all, is **TBD**.
It is answerable in one call once the API key exists — ask the server for
`SELECT current_user` and then try a write — and it must be answered before U10's
Agent Skill claims the read path is read-only. V9 is the precedent: the platform hands
out `admin` by default, so the assumption to test is that this principal is over-privileged too.

**Answered in part by V10.** The managed server does publish `insert_rows`,
`create_table` and `create_database`, so it is not a read plane whatever its SQL
identity turns out to be. The identity itself is still TBD: the service account has no
roles, so every SQL tool answers `unauthorized`. `npm run probe:read` settles it.

### `06` §4 said 24 tasks while its own composition summed to 30 *(corrected 2026-08-10)*

§4 asked for "a seeded task list of 24 tasks", then listed 8 independent + 6 pairs + 5
overlapping + 3 recall-dependent + 2 abandoned. Six pairs is twelve tasks, so the
bullets sum to 30; only reading "6 pairs" as six *tasks* in three pairs reaches 24.

Settled by Julian in favour of the bullets, and §4 now says 30. The reasoning: `08` §7
ranks "benchmark shows no difference" as low-likelihood and high-impact and prescribes
raising the overlapping-task share, and the duplicate pairs are that share. Twelve of
thirty duplicates gives `duplicate_work_rate` room to separate the arms; six of
twenty-four does not.

### `05` §3 — `cortex_heartbeat` had prose and no JSON block *(corrected 2026-08-09)*

§3 published `inputSchema` blocks for `cortex_propose` and `cortex_close` and only two
sentences of prose for `cortex_heartbeat`, while U7's done-when asks for three schemas
from §3. The gap was in the spec, not in the reading of it.

Closed by writing the block into §3 from §1's `heartbeat(repo, intentId, extendBy?)`,
which the spec does give, rather than inventing a shape. `test/mcp.test.ts` now holds
§3's field list against §1's signature, since the two sections are written
independently and nothing else compared them.

### `05` §3 — the blocks omit `additionalProperties`, so the schemas do not close themselves

Still true of the spec text, and deliberately not changed. The published blocks
document a closed field list without enforcing one, which is fine as documentation and
insufficient as a boundary: invariant 7 is a claim about what reaches a handler, not
about what a schema says.

`src/mcp/server.ts` rejects any argument the schema did not declare, and a test drives
`{sql: "DROP TABLE claims"}` at `cortex_propose` over the wire to prove it. Editing the
spec to add `"additionalProperties": false` to each block would be an improvement, but
it would also make the verbatim-copy test compare against a moved target for no
behavioural gain — the enforcement already exists and is tested. Recorded so the
omission is understood as known rather than overlooked.

## Departures recorded while building, not errors in the spec

### `04` §2 routes flow D through EventBridge; the changefeed sink does it inline *(2026-08-11, U16)*

§2's component map puts `EventBridge ──► Lambda: consolidate` between the changefeed
ingress and `findings`. `infra/lambda/changefeed.ts` consolidates in the sink handler
instead, and the bus is not deployed.

What EventBridge buys is asynchrony and an independent consumer. The asynchrony is already
there: the sink answers 200 whatever consolidation does, a consolidation failure is caught
and logged rather than retried, and `04` §6 already accepts that a stalled feed shows a
staleness badge rather than blocking an agent. What it would *additionally* buy is a
separate concurrency pool for the two consumers — and on an account where reserved
concurrency cannot be set at any value (V26), there is no pool to separate. The bus would
have added a hop and a failure mode for no behaviour this deployment can express.

Recorded rather than reconciled: if the concurrency restriction is ever lifted, splitting
the consumers becomes worth doing, and §2's map is then right rather than aspirational.

### `06` §2 puts the naive arm's shared state on disk; the demo's is a JSONB cell *(2026-08-12, U16b)*

§2 specifies the NAIVE arm as "shared state: JSON file on disk, last-write-wins", and
`bench/arms/naive.ts` implements exactly that. The hosted demo's naive arm implements the
same mechanism against `repos.demo_shared_state` instead, because a demo whose naive arm
touches no database executes no statements — and an arm that executes nothing cannot lose a
write, which is how two of its meter figures came to be written by hand rather than
measured.

Not a contradiction: §2 governs the benchmark, `07` governs the demo, and the property §2 is
specifying is *last-write-wins on a whole-artifact rewrite*, which is preserved exactly —
read the whole cell, hold it while working, write the whole cell back. Recorded because a
reader comparing `bench/arms/naive.ts` with `src/memory/shared-state.ts` will find two
implementations of one specified behaviour and should know that is deliberate.

### `03` §5's base back-off moved from 20ms to 250ms *(2026-08-12, V31 — closed)*

This was an **Open** entry between V30 and V31 and is closed, so it sits here rather than
above: §5 was never wrong. It requires "exponential backoff plus jitter, capped at five
attempts" and names no constant, so choosing one is implementation, not deviation.

What made it worth recording is that the constant was wrong in a way only genuine
concurrency could reveal. At 20ms the four sleeps totalled ~300ms against a `propose`
transaction that spends about a second on the wire, so two colliding agents backed off by a
third of the window they collided in and restarted into each other. Measured with the same
12-run probe before and after, in isolation both times:

```
BASE_DELAY_MS = 20    cortex: threw 1/12 · retries 0,1,8,1,1,1,6,1,1,1,1,1
BASE_DELAY_MS = 250   cortex: threw 0/12 · retries 0,1,1,1,1,1,1,1,3,3,1,1
                      naive:  threw 0/12 · retries 2,2,2,2,2,2,2,2,2,2,2,2
```

`retries 8` is two agents each exhausting four attempts — the loop failing to converge. After
the change the modal value is 1, which is what convergence looks like: the loser conflicts
once, backs off past the winner's commit, retries alone and is cleanly blocked.

Every property `src/db/retry.ts` documents is stated relative to the constant and is
unchanged, so `test/retry.test.ts` needed no edit — that it asserts against `BASE_DELAY_MS`
rather than against literals is why this was a one-line change and not a rewrite.
