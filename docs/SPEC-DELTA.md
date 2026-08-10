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

### `05` §2 — the Node-versus-Python `[OPEN]` is answered in practice, still marked open

§2 leaves the CLI runtime open with a mild preference for Node. Everything in the
repository is Node and TypeScript, and B1 committed to one module system across all
of it with `npx tsc --noEmit` clean. Choosing Python now would mean adding a
toolchain, not picking between two.

**Not edited, deliberately.** Closing an `[OPEN]` is Julian's call and was not made as
a side effect of a build fix. Reasoning in `docs/DECISIONS.md`. The cost of leaving it
is that a reader of §2 may think the question is live and re-open it.

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

### `03` §4.2 — `DEDUPE_THRESHOLD` 0.28 is below the band the corpus needs

Still `[OPEN]` in the spec, correctly — §4.2 says the right value is empirical and asks
for a sweep. U11 produced the first measurement, and it says the default is too tight.
On the committed corpus, Titan Text Embeddings V2 at 1024 dimensions:

- worst genuinely-duplicate pair: **0.3630**
- closest combination that is *not* a duplicate: **0.4293**
- so any threshold in **(0.3630, 0.4293)** classifies all thirty tasks perfectly
- at the shipped **0.28**: 4 of 6 pairs caught, 0 false positives

The constant in `src/memory/propose.ts` has **not** been changed. Picking it belongs to
U13's `bench/results/threshold-sweep.md`; moving the mechanism's threshold to fit a
fixture is the wrong direction of fit. This is input to that sweep, not a decision.
Numbers and the failed first draft are in V11.

## Corrected in the spec already — do not re-open

### `04` §3 / `05` §3 — "governed by Cloud RBAC" did not describe the managed MCP server *(resolved 2026-08-10 — the route changed)*

**Closed by decision, not by wording.** Julian chose to drop the managed-MCP read path
rather than try to constrain its principal. Reads are now issued as `cortex_reader`
over `CORTEX_READER_DSN`, whose read-only property `test/privilege-planes.test.ts`
asserts by attempting nine writes and requiring all nine to refuse with 42501.
`04` §1, §3 and §4 and `05` §3, §4 and §6 are corrected in place; reasoning in
`docs/DECISIONS.md`, measurement in V17. `CORTEX_MCP_*` survives in `.env` as
diagnostics for `npm run probe:read` and is labelled as such.

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
