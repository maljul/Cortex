# CORTEX

**Shared, arbitrated memory for fleets of coding agents.**

<!--
  TODO before publishing: an ≤8s GIF above this line, showing two agents reaching for
  one file, one standing down, the counter incrementing. 09-DISTRIBUTION.md §2 ranks it
  the single highest-converting element on this page. It does not exist yet, so it is
  not linked yet — a broken image is worse than no image.
-->

| metric              | naive | cortex |
| ------------------- | ----: | -----: |
| duplicate_work_rate |  0.21 |   0.00 |
| lost_writes         |    21 |      0 |

**Try it:** <https://d11xbslgdgomdp.cloudfront.net> — no account, no key, no cluster, no
card, nothing to install.

**Run it on your own repository:** you bring your own free CockroachDB cluster and your
own credentials. That is the [setup path below](#run-it-on-your-own-cluster), and it is
deliberately not the same thing as trying it.

> Durable execution gives exactly-once within one workflow. It does not give mutual
> exclusion between agents that do not know each other exists.

---

## What it is

Five coding agents on one repository do not know about each other. They redo each
other's work, overwrite each other's edits, and rediscover the same dead end
independently. CORTEX gives them one place to remember and one place to ask permission,
and makes those the same place: **a single `SERIALIZABLE` transaction in CockroachDB
that checks semantic similarity and acquires the right to act on the same snapshot.**

It is not an orchestrator and not an agent framework. Agents keep their own runtimes,
their own prompts, and their own model. What they gain is a memory they share and an
arbiter that a separate vector store plus a separate lock service cannot be, because
those two have no common commit point.

## The four memory tiers

Each tier is a database primitive, not an application convention
(`spec/03-MEMORY-MODEL.md` §1, schema in `sql/001_init.sql`).

| Tier           | Table           | Lifetime mechanism                     | Contains                                          |
| -------------- | --------------- | -------------------------------------- | ------------------------------------------------- |
| **Working**    | `claims`        | row-level TTL, swept every minute      | who currently holds the right to act on a resource |
| **Episodic**   | `intents`       | append-only; TTL 30 days on closed rows | every attempt: what was wanted, by whom, what happened |
| **Semantic**   | `findings`      | durable, no TTL                        | facts about this codebase, distilled from closed intents |
| **Procedural** | `action_ledger` | durable, no TTL                        | the idempotent record of side effects actually applied |

Two further tables, `repos` and `agents`, are identity rather than memory — six tables
in total. A seventh, `live_run_budget`, is the hosted demo's cost brake and is not
memory; the read plane cannot even `SELECT` it.

An agent process that dies releases nothing by hand. Its claims expire and are reclaimed
by the TTL job.

## The one query a vector database cannot run

Semantic similarity joined to structural outcome history, ordered so that facts about
changes that were *reverted* come first. It is exported as `RECALL_SQL` from
`src/memory/recall.ts`, and `skills/cortex-memory/SKILL.md` carries it byte-for-byte —
`test/skill.test.ts` fails if either copy drifts.

```sql
WITH near AS (
  SELECT id, fact, source_intent_id, confidence, contradictions,
         embedding <=> $1 AS dist
  FROM findings
  WHERE repo_id = $2
  ORDER BY embedding <=> $1
  LIMIT $3
)
SELECT n.fact,
       n.confidence,
       n.dist,
       count(i.id) FILTER (WHERE i.outcome->>'result' = 'reverted') AS times_reverted,
       max(i.closed_at)                                             AS last_touched
FROM near n
LEFT JOIN intents i ON i.id = n.source_intent_id AND i.repo_id = $2
WHERE n.dist < $4
GROUP BY n.fact, n.confidence, n.dist
ORDER BY times_reverted DESC, n.dist ASC
LIMIT $5
```

Both `repo_id` predicates are load-bearing and are asserted separately by test. The
`VECTOR INDEX (repo_id, embedding)` prefix makes single-tenant recall the fast path; it
is **not** the isolation boundary. A query that omits the filter does not fail closed —
it falls back to a full scan and returns another repository's rows (`docs/verification-log.md` V5).

## Privilege planes

Three principals on one cluster, none of which can become another
(`docs/architecture.md` has the full picture).

| Plane          | Principal       | Reached over          | Can it write memory                                    |
| -------------- | --------------- | --------------------- | ------------------------------------------------------ |
| **Read**       | `cortex_reader` | `CORTEX_READER_DSN`   | no — `SELECT` only, no write verb anywhere              |
| **Write**      | `cortex_writer` | `CORTEX_WRITER_DSN`   | yes, and only through the typed `cortex_*` MCP tools    |
| **Demo write** | `cortex_demo`   | `CORTEX_DEMO_DSN`     | yes, confined by row-level security to one live, expiring demo scope |

The agent never holds write credentials. A prompt-injected agent cannot corrupt the
fleet's memory because it has no verb with which to do so, and the write surface exposes
no SQL, no table name and no structural parameter.

**This is a claim you can run rather than one you are asked to believe.**
`test/privilege-planes.test.ts` attempts the statements against the live cluster: nine
writes as `cortex_reader` (an `INSERT` on each of the six memory tables, plus an
`UPDATE`, a `DELETE` and a `DROP`), each required to refuse with SQLSTATE 42501. It reads
no catalogue on purpose — `SHOW GRANTS` once answered a narrow question truthfully while
the accounts held `admin` through a role membership nobody had asked about.

The agent's read path is a **SQL grant, not the CockroachDB Cloud Managed MCP Server.**
That server was the design until it was measured: it executes as `managed-mcp`, which
holds `INSERT` and `DELETE` on `claims` — confirmed by invoking `insert_rows` and getting
`23502` (a constraint violation) rather than `42501`. An agent handed that endpoint for
recall would have held an unarbitrated write path into the two tables arbitration exists
to protect. The route was dropped. Details in `docs/verification-log.md` V17.

## Benchmark

Quoted from **`bench/results/2026-08-12T18-35-38-014Z/summary.md`**, which is the only
place these numbers are published. Median of three runs per arm, seed 1729, 5 agents,
30 tasks.

| metric                | naive | cortex |
| --------------------- | ----: | -----: |
| duplicate_work_rate   |  0.21 |   0.00 |
| lost_writes           |    21 |      0 |
| conflicting_edits     |     3 |      0 |
| wasted_tokens         |  4000 |    867 |
| goodput (tasks/min)   | 38.16 | 200.73 |
| claim_p50 (ms)        |     — |    732 |
| claim_p95 (ms)        |     — |    818 |
| serialization_retries |     — |      0 |

Both arms ran the same 30 tasks, dealt to the same 5 agents in the same seeded order, on
the same simulated clock, drawing on the same recorded reasoning and the same recorded
embeddings. The only difference is where the shared state lives. Model reasoning is
replayed; **database behaviour is live in both arms** — the NAIVE arm really does lose
writes to its JSON file and is not scripted to.

### Limitations, stated by the author

These are quoted from the same `summary.md`. They are load-bearing, not decoration, and
two of the rows above mean less than they look like they mean.

- **Small synthetic corpus.** 40 fixture files, 30 tasks, one workload shape. Overlap was
  chosen so the failure modes appear at all; a repository with less overlap would show
  less difference.
- **Replayed reasoning.** The agents do not think during a run. Reasoning was recorded
  once against Bedrock and is replayed identically for both arms.
- **The harness serialises, so two of the metrics are not what they appear to be.** One
  step runs at a time so the run reproduces, which means two transactions never overlap:
  **`serialization_retries` is 0 by construction**, not by merit, and **`claim_p50` and
  `claim_p95` are uncontended latencies**. The real race is evidenced separately, by
  `npm run gate:contend` and by `test/retry.test.ts`.
- **CORTEX recall returns nothing in this harness, and the benchmark therefore
  understates CORTEX.** `findings` is populated by consolidation, which is
  changefeed-driven; this harness runs no changefeed, so the table stays empty for the
  whole run and every recall returns 0 rows. The NAIVE arm meanwhile reads its own local
  note store and gets real hits, so on the three recall-dependent tasks the comparison
  runs against CORTEX. This is a harness boundary, not unbuilt consolidation
  (`npm run gate:consolidate` proves consolidation end to end) and not the recall
  distance threshold (moving it 0.35 → 0.60 changed no metric in the table, because an
  empty table returns nothing at any distance).
- **Single region, single cluster tier.** See `environment.json` in the results directory.
- **`goodput` is per simulated minute, not per wall-clock minute.** Wall clock would
  compare a local file write against a cloud round trip and call the difference a
  coordination result.

### The threshold was changed after the benchmark recommended it

The dedupe threshold ships at **0.39** (`src/memory/propose.ts`); the offline judge scores
at **0.4** (`bench/metrics.ts`). They are different numbers on purpose — the judge scores
the benchmark that justifies the mechanism, and one shared constant would read as the two
having been tuned together. The threshold previously shipped at 0.28, where the published
row was 0.21 → 0.08. The sweep, the prior value, the current value and the fact that one
followed the other are all published in the results directory
(`threshold-sweep.md`). Reasoning in `docs/DECISIONS.md`.

## Run it on your own cluster

`npx cortex init` brings a cluster from empty to working, and is safe to run twice. It
does **not** provision a cluster — you create the cluster, it does everything after that:
creates the SQL roles `sql/001_init.sql` grants to, writes their connection strings into
`.env`, applies the schema, and then proves the three privilege planes by *attempting*
statements against them rather than by reading a catalogue.

`cortex doctor` is the companion: what `.env` carries, which planes connect and as whom,
which tables exist, and whether a connection string has leaked into any tracked file.
Neither command ever prints a credential — key names, character counts and verdicts only.

Everything else is an npm script, and `package.json` is the authority on their names.

**Prerequisites**

- Node with `process.loadEnvFile` (the published run used Node v24.14.1 — see
  `bench/results/2026-08-12T18-35-38-014Z/environment.json`).
- A CockroachDB Cloud cluster of your own. The free tier is enough; the published run
  used Basic tier in `aws-us-east-1`.
- Bedrock credentials are **not** required to reproduce the benchmark — it replays
  committed cassettes and reports `liveCalls: {embed: 0, reason: 0}`. They are required
  for the live demo, the recall sweep, and anything that embeds a new statement.

**Steps**

```bash
git clone <this repository>
cd <the checkout>
npm ci
npx tsc --noEmit          # should exit clean before you touch anything
```

Create the cluster in the CockroachDB Cloud Console and copy its connection string.

Copy `.env.example` to `.env` and set **`CORTEX_DSN`** to that string — an operator
credential able to run DDL. That is the only variable you have to fill in by hand;
`cortex init` derives and writes the three role DSNs below. `.env` is gitignored and must
stay that way. The variables that matter:

| Variable            | What it is                                                                                       | Needed for                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `CORTEX_DSN`        | the operator credential — an admin able to run DDL and manage changefeed jobs                     | `npm run sql`, `npm run changefeed`, `npm run db:check` |
| `CORTEX_WRITER_DSN` | `cortex_writer`; the application's write plane (`src/db/pool.ts`)                                 | the benchmark's CORTEX arm, the MCP tools, most tests |
| `CORTEX_READER_DSN` | `cortex_reader`; the agents' read plane, used by the published skill                              | recall, `npm run probe:read`, the privilege-plane tests |
| `CORTEX_DEMO_DSN`   | `cortex_demo`; the hosted demo's confined principal                                               | the demo surface and its tests                        |
| `BEDROCK_REGION`, `BEDROCK_EMBED_MODEL`, `BEDROCK_REASON_MODEL` | Titan Text Embeddings V2 and the reasoning model      | live embedding and LIVE mode; not the replayed benchmark |
| `CORTEX_REPO_ROOT`  | path to the checkout the MCP server expands `glob:` resource keys against                         | `npm run serve` with glob keys                        |

Wrap every value in single quotes. Node's env-file loader is not `dotenv`: it truncates
at an unquoted `#`, and it will not override a variable your shell already exports.
`npm run env:doctor` diagnoses both — it prints key names, value lengths and structural
problems, and never prints a value.

Then bring the cluster up:

```bash
npx cortex init      # creates the roles, writes their DSNs, applies the schema,
                     # and proves each plane by attempting statements against it
npx cortex doctor    # what connects, as whom, and whether a DSN has leaked into a file
```

`init` is safe to run twice: an existing role is reported and left alone, and no password
is ever rotated. Run it again any time — it is also the fastest way to confirm a cluster
is still correctly configured. If you would rather drive the migration yourself,
`npx tsx scripts/sql.mts sql/001_init.sql --stop-on-error` still does exactly that, and
`npm run db:check` reports DSN shape without printing a DSN.

`001_init.sql` sets `feature.vector_index.enabled`, creates the six memory tables plus
`live_run_budget`, creates both vector indexes, applies the grants, and enables `FORCE
ROW LEVEL SECURITY` with the demo policies.

**Reproduce the benchmark**

```bash
npm run bench:results
```

This writes a **new** timestamped directory under `bench/results/`. The coordination
outcomes are deterministic at a fixed seed against the committed cassettes, so every row
except the wall-clock ones should match the published table exactly; compare them and
then delete the new directory. Two published results directories means a reader guessing
which one is quoted.

What needs no cluster at all: everything except re-running. The cassettes, the published
table, `environment.json`, the full per-arm run records and the offline judge are all
committed and readable from a clean clone.

`recall-threshold-sweep.md` in the results directory is the exception — `npm run
sweep:recall` writes it with live Titan calls and the cluster's own `<=>` operator, and
there are no cassettes behind it. Its ground truth (`bench/recall-truth.json`) and its
published table are committed; reproducing the numbers needs Bedrock and a cluster.

## Commands

| Command                                 | What it does                                                              |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `npx cortex init`                       | empty cluster → working one: roles, their DSNs, the schema, and each plane proved by attempting statements. Safe to run twice |
| `npx cortex doctor`                     | what `.env` carries, which planes connect and as whom, and whether a DSN has leaked into a tracked file |
| `npm test`                              | Vitest, **against the real cluster**. One run takes about ten minutes; do not run two at once, and let the cluster rest between runs. |
| `npx tsc --noEmit`                      | typecheck; exits clean and must stay that way                             |
| `npm run db:check`                      | connectivity and DSN shape for both planes                                |
| `npm run env:doctor`                    | why a key in `.env` is not arriving in `process.env`                      |
| `npm run sql`                           | apply a `.sql` file statement by statement                                |
| `npm run serve`                         | the CORTEX MCP server on stdio (`cortex_propose`, `cortex_close`)         |
| `npm run bench` / `npm run bench:results` | one benchmark run / the published three-run table                       |
| `npm run gate:contend`                  | proves the real race: concurrent agents, one winner                       |
| `npm run gate:stream`                   | changefeed row → hosted API → WebSocket, end to end                       |
| `npm run gate:consolidate`              | a closed or abandoned intent becoming a durable finding                   |
| `npm run gate:degrade`                  | forces the embedding-throttle rung of the degradation ladder              |
| `npm run gate:workload`                 | the ten-ticket two-arm fleet run against the real cluster, with both meters |
| `npm run gate:async`                    | the run handed off and streamed, against the deployed stack               |
| `npm run measure:statements`            | every pairwise Titan distance between demo statements; run after any rewording |
| `npm run sweep:recall`                  | republishes the recall-threshold table (live Titan + cluster `<=>`)       |
| `npm run changefeed status\|create\|cancel` | manage the changefeed job                                             |
| `npm run probe:read` / `npm run probe:reason` | read plane and reason model, invoked rather than assumed             |
| `bash scripts/gate-mechanical.sh --report` | the mechanical pre-commit checks, including the credential scan        |

Agent commits are additionally blocked by `.githooks/pre-commit`, which needs one command
per clone: `git config core.hooksPath .githooks`.

## What happens when things go wrong

| Failure                          | Behaviour                              | Mitigation                                                            |
| -------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| agent process dies holding claims | claims expire                          | row-level TTL sweeps every minute; no manual recovery                 |
| serialization conflict (40001)   | transaction retried                    | bounded retry with jitter, capped at five attempts, then one visible re-plan |
| Bedrock throttled or unavailable | intent cannot be embedded              | deterministic local hash embedding, intent marked `embedding_degraded`, dedupe **skipped** for it rather than run at a meaningless threshold |
| changefeed stalled               | consolidation lags, live view freezes  | agents are unaffected — consolidation is off the critical path         |
| cluster unreachable              | agents cannot claim                    | **fail closed**: no claim means no action, never act unarbitrated      |
| demo LIVE quota exhausted        | LIVE disabled, REPLAY unaffected       | a global run counter in the database; the UI switches and says so      |
| demo session row cap reached     | that session goes read-only            | its rows, counters and SQL log stay inspectable; a new session is one click |
| prompt-injected agent            | attempts a destructive write           | it has no write verb, and the write API exposes no arbitrary SQL       |

No limit this system can reach is allowed to produce an error page or a credential
prompt. The full ladder is in `docs/architecture.md`.

## Documentation

| Where                        | What                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `docs/architecture.md`       | the diagram, the data flows, privilege planes, the degradation ladder |
| `docs/third-party.md`        | dependency licences                                                   |
| `docs/verification-log.md`   | what was checked against a live cluster, and when                     |
| `docs/DECISIONS.md`          | why something was decided                                             |
| `docs/SPEC-DELTA.md`         | every place `spec/` no longer matches what is built                   |
| `docs/UNITS.md`              | build status of record                                                |
| `spec/`                      | the specification the build is executed against                       |
| `skills/cortex-memory/SKILL.md` | the published Agent Skill: recall SQL and when to declare an intent |

## Prior work and dependencies

No third-party source code is vendored into this repository — `node_modules/` and the
esbuild Lambda bundle are gitignored, and nothing under `src/`, `bench/`, `infra/`,
`sql/`, `scripts/`, `test/` or `skills/` is a copy of someone else's code. The first
commit is dated 2026-08-01, inside the submission period; the git history is the record.

Runtime and build dependencies are installed from npm and are listed with their licences
in [`docs/third-party.md`](docs/third-party.md). CockroachDB, Amazon Bedrock, and the
other AWS services are used as hosted services, not redistributed.

## Licence

MIT. See [`LICENSE`](LICENSE); the `license` field in `package.json` says the same thing.
