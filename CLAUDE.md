# CORTEX

## Current state

**`docs/UNITS.md` is the status of record.** What is done, what is next, and why
anything was deferred lives there and only there. This block used to duplicate it
and the two drifted within a day, which cost a unit of ambiguity over whether U2 or
U7 came next. Do not reintroduce a unit list here.

- Unit status, ordering, next unit → `docs/UNITS.md`
- **The fleet demo's design → `docs/superpowers/specs/2026-08-12-fleet-demo-design.md`.**
  Julian's, 2026-08-12. It replaces the demo's four scripted beats with a real ten-task
  two-arm workload run, and its §11 **displaces the unit order**: U21–U26 are now in
  `docs/UNITS.md` and U2 slips behind all of them. It is additive — decision 7 keeps the
  current deployed page serving until U26's cold read passes — so nothing in it can cost
  the submission. **Two of its numbers are already superseded by measurement:** §7.3 calls
  the Bedrock rate unconfirmed and quotes $3.00/$15.00 from a secondary source; it is
  measured at **$3.30/$16.50** (V36), which puts a designed LIVE run at **$0.495** and
  single-digit dollars at roughly **18 runs for the whole event**, not 40 a day.
- Evidence for every claim → `docs/verification-log.md`
- Why something was decided → `docs/DECISIONS.md`
- Where `spec/` no longer matches reality → `docs/SPEC-DELTA.md`

What does not belong in a unit list, and so lives here:

- Verification gate: **5/5**, resolved 2026-08-09. Embeddings PASS at 1024 dims;
  v5 reasoning models are **not entitled** on this account, so the reason model is
  `us.anthropic.claude-sonnet-4-5-20250929-v1:0`.
- Off-plan: `src/extract/graph.ts` belongs to consolidation (§4.4) — **do not extend**.
- **The hosted demo is deployed and anonymous, U14, V26, 2026-08-11.** `infra/cdk/` (was
  `cdk-spike/`) deploys stack `CortexStack`: four Lambdas behind API Gateway HTTP, a
  WebSocket API, a DynamoDB connection registry, S3 + CloudFront. IaC is **CDK** — `04`
  §2's `[OPEN]` is closed, and the ten-minute criterion tied rather than decided (CDK 42s
  / SAM 33s redeploy). Lambda reaches CockroachDB Cloud with no TLS work, no VPC: cold
  `queryMs` ~690, warm 3 on a reused pool.
  Site https://d11xbslgdgomdp.cloudfront.net · API
  https://clotk5952m.execute-api.us-east-1.amazonaws.com · stream
  `wss://4hiryvz6yd.execute-api.us-east-1.amazonaws.com/live`.
  Every DSN is a `{{resolve:secretsmanager:...}}` dynamic reference, never a template
  value — the first arrangement leaked one into `cdk.out/` and that is why. **Rebuild the
  bundle with `node infra/bundle.mjs` before every deploy**; nothing does it
  automatically, and `npm run deploy:secrets` must have run once or CloudFormation fails
  on an unresolvable secret.
- **Consolidation (`03` §4.4) is built and beat 4 is real (U16, V27, 2026-08-11).** The
  changefeed sink embeds a closed intent's outcome and either reinforces the nearest
  finding in that repository or inserts one. `npm run gate:consolidate` proves it end to
  end in 502ms. The candidate search carries `WHERE repo_id`, and mutating it away fails
  all seven tests in the file — without it a fresh consolidation reinforces one of the
  cluster's existing findings instead of inserting. `04` §2 routes this through
  EventBridge and the deployment does not; reasoning in `docs/SPEC-DELTA.md`.
- **`03` §4.1's recall threshold is CLOSED at `0.60` — Julian's call on 2026-08-12 from the
  sweep (V33/V34). It was 0.35, and §4.1 still publishes 0.35, so `docs/SPEC-DELTA.md` carries
  the deviation.** `npm run sweep:recall` publishes
  `bench/results/2026-08-12T18-35-38-014Z/recall-threshold-sweep.md` against ground truth in
  `bench/recall-truth.json`, authored before anything was measured, distances from the
  cluster's own `<=>` on live Titan vectors. **At 0.35 one query in eight was served; 0.60 is
  the largest tested threshold with zero false positives; the first false positive is at 0.63.**
  Ranking separates perfectly (8/8) but the nearest relevant finding sits anywhere from 0.2981
  to 0.7364, so there is no perfect band and no single constant serves everything.
  The non-circular justification, and it predates the demo's need for it: recall at 0.35 was
  *tighter* than dedupe at 0.39, which is backwards, because a dedupe false positive cancels
  work that needed doing while a recall false positive only costs attention. **0.60 is the top
  of the free range, not the smallest value that rescues beat 1** — that would have been 0.39,
  which is also the dedupe constant. The sweep's own hard negatives did not land close under
  Titan, so its precision column is optimistic and it bounds the constant **from below**; if a
  harder corpus breaks precision earlier, this number comes down.
  **Three places carry this number and none may be a second literal:** `DEFAULT_MAX_DISTANCE`
  in `src/memory/recall.ts` is the source; `bench/arms/shared.ts` re-exports it (the CORTEX arm
  inherits it and the NAIVE arm filters its own store with it — two literals would have given
  one arm a wider memory and called the difference a coordination result); and
  `skills/cortex-memory/SKILL.md`'s `$4` row is asserted equal to it by `test/skill.test.ts`,
  because the SQL is parameterised so the byte-for-byte pin cannot see that drift.
  **The benchmark did not move.** Every `06` §3 metric is identical at 0.60 and 0.35, because
  nothing populates `findings` in that harness — it runs no changefeed — so recall returns 0
  rows at any distance. This also corrects U12 and the old summary limitation: the benchmark's
  zero recall is a harness boundary, not unbuilt consolidation (V27 built it) and not the
  threshold.
- **All five of `05` §5's demo routes exist, and the show-SQL panel is a transcript**
  (U16, V28). `src/db/recorder.ts` wraps the live client, so a statement reaches the panel
  only by having gone to the driver. Since U16b the log is **grouped by transaction**
  (`RecordedStatement.txn`, one per `withRetry` attempt) because concurrent agents interleave
  two `BEGIN`s and a flat list stops showing invariant 1 at all; grouped, each block holds
  its own dedupe search and its own claim insert. **The SPA is built, deployed, and U16 is
  closed** (`infra/site/index.html`, V29) — Julian read the deployed page cold on
  2026-08-12 and the four beats land. That was the unit's whole remainder; no test could
  have answered it.
- **The demo's agents are genuinely concurrent and every meter figure is measured (U16b, V30).**
  Two things were fabricated before this and both are gone: `meter.duplicateWorkDone += 1`
  and `meter.lostWrites += 1` were unconditional, and the NAIVE arm executed **zero
  statements** — an arm that transacts nothing cannot lose a write. It now does real
  read-modify-write work against `repos.demo_shared_state` (`src/memory/shared-state.ts`,
  `06` §2's last-write-wins against a row rather than a file), and `lostWrites` is a
  subtraction over a readback. `duplicate work done` is measured for **both** arms by one
  rule — the dedupe threshold applied after the fact, with distances computed by the
  cluster's own `<=>` (`src/memory/duplicates.ts`) — so `07` §1's "every number comes from
  the database" holds literally. `test/scenario.test.ts` fails if a meter figure is set from
  a numeric literal or incremented without a condition. **Beat 3 is a real race** and
  `SCRIPT.claimWinner`/`claimLoser` are now `contenderA`/`contenderB`: nothing may assume
  which one wins. **Beat 2 is deliberately still a sequence** — dedupe is a temporal
  relationship, and racing it deletes the beat rather than hardening it.
- **`03` §5's five-attempt cap is reachable now that agents genuinely contend, and the
  backoff is why (V30).** Both beat-3 agents exhaust it on roughly one run in twelve:
  `backoffMs` sleeps 20–320ms in total against a propose transaction that takes about a
  second, so two colliding agents restart into each other. The demo follows §5's own next
  sentence — an exhausted agent **re-plans once**, visibly (`replanOnce` in
  `src/demo/scenario.ts`) — and an exhausted re-plan is reported as `contended`, never as an
  exception, because that path is behind the run button and `04` §5 invariant 1 admits no
  error page. **`backoffMs`'s base delay was 20ms and is now 250ms** —
  Julian's call on 2026-08-12 after the measurement (V31), because 20ms against a
  one-second transaction is a third of the window the agents collided in. Exhaustions went
  **1/12 → 0/12** and retries settled at 1, which is what the loop converging looks like.
  Every documented property of `backoffMs` survives, because each is stated relative to the
  constant — `test/retry.test.ts` asserts against `BASE_DELAY_MS` rather than literals and
  needed no edit. The cap stays at five: raising it would contradict §5. `replanOnce` stays
  too; it is §5's own instruction, not a workaround for it.
- **LIVE reasoning is still not built, but both things that blocked it are now closed
  (U17, V36, 2026-08-12).** `04` §5 brake 2's global run counter is built on a **seventh
  table**, `live_run_budget` — Julian's call, reasoning in `docs/DECISIONS.md`. It carries
  no `repo_id` because §5's counter is global, and that exemption from invariant 5 is
  asserted against `information_schema` so it cannot widen. `cortex_demo` reaches today's
  row and no other day, and holds no DELETE.
  **The cap is `LIVE_RUNS_PER_DAY = 10`, not §5's 40**, because the Bedrock rate is now
  measured: **$3.30 per 1M input, $16.50 per 1M output**, taken from this account's own
  billing after AWS's pricing page failed twice (V30) and its **Price List API turned out
  not to carry Sonnet 4.5 at all**. At that rate §5's own default costs $19–36 through
  2026-09-15 against §5's own "single-digit dollars" — the deviation is in
  `docs/SPEC-DELTA.md`. **Cost Explorer bills it under `Claude Sonnet 4.5 (Amazon Bedrock
  Edition)`, a service distinct from `Amazon Bedrock`** — so brake 3's Budget must filter on
  that name or it will watch a meter carrying only the Titan line and never fire.
- **Abandonment is memory now, and a finding is embedded on the work rather than the obstacle
  (U21, V39, 2026-08-13).** `03` §4.4 said consolidation fires on rows transitioning to `done`,
  and three places implemented it — so an abandoned intent's `abandonReason` was written down
  and **reachable by nobody**: not by `recall()` (no finding), not by dedupe (`03` §4.2's SQL
  excludes `abandoned`). The fleet paid for its most expensive knowledge and discarded it.
  `CONSOLIDATES` is now `done` **and** `abandoned` — Julian's call; `proposed`/`in_flight` are
  unfinished and `deduped` never happened, but an abandoned intent is a concluded outcome.
  **Dedupe is deliberately unchanged**: a later agent is informed, never stopped, because
  "someone gave up" is not evidence work is impossible.
  **And what is embedded is not what is stored, for abandonment only.** Measured: the
  abandonReason sits **0.6725–0.7246** from the task it exists to warn — outside recall's 0.60 —
  while the bare `"<statement> — abandoned"` sits **0.4698–0.4899** and is retrieved by all of
  them; both in one sentence misses by two hundredths. The note names the obstacle, the task
  names the work. Left alone that ships "the agent that explains itself produces memory nobody
  can find". `retrievalKeyFromClosedIntent` is the seam. **Scoped to abandonment** — V28's 0.3801
  for the seed exists *because* the note is embedded, and beat 1 fires on it.
  **The changefeed sink's second copy of the status rule was deleted, not updated** — it would
  have vetoed this silently while the unit test passed. **Not deployed:** `ChangefeedFn` still
  carries the old filter until `node infra/bundle.mjs && npx cdk deploy`.
- **The mechanical gate's `credentials` row blesses declared strings, not a shape (V42,
  2026-08-13).** It had read FAIL on every `--report` run since 2026-08-11 on three of this
  repo's own placeholders, and **rewriting them into the blessed shape cannot fix it**:
  `--report` scans `git log -p --all` and all three are `+` lines in commits `0219d24` and
  `50a984b`, which no working-tree edit can reach. `PLACEHOLDER_STRINGS` is now an inventory of
  the **seven** exact connection strings in the whole of history, matched with `grep -F`. It is
  **stricter, not equal**: the old `user:password@` excused every DSN whose password was the
  word `password` on any host for ever, and the inventory excuses seven strings and nothing —
  unseen future strings excused goes from unbounded to zero, at the stated price of three fixed
  literals that were caught and now are not. **An empty inventory would make the row an
  unconditional PASS** (`grep -vF ''` excuses everything), so the script refuses to run on one.
  `test/gate-mechanical.test.ts` runs `--report` for real and fails if a shape is ever re-added.
  Adding a placeholder is meant to be a decision — a new one turns the row red until it is
  written down. **The check proved itself on its own author within the hour**, catching a
  credential-shaped literal in the very test that asserts such literals are caught; the old
  shape would have excused it silently. Write about these patterns without spelling them out —
  that has now cost three commits.
  **The `PreToolUse` commit hook did not fire in this session and the script is not why**
  (V42): hook mode blocks correctly when invoked directly with a payload, exit 2. A hook that
  silently does not run is indistinguishable from one that passes. Check `/hooks` before relying
  on the commit block; `bash scripts/gate-mechanical.sh --report` is the entry point known to
  run.
- **A missing feature is attributed by code, not by prose (V41, 2026-08-13).** U21's third
  silent break was written down in `docs/UNITS.md` and checked by nothing.
  `src/demo/attribution.ts` returns one record per feature and `unattributableLosses` refuses
  any feature present under arbitration and absent without it that lacks an agent, an intent id,
  or an intent id the run's own steps contain. **The runner owes it a `WorkStep` per task per
  arm** — `{ taskId, agent, intentId, reported }` — and `reported` must distinguish `done`,
  because attributing a loss to a deduped agent is a false accusation that passes every null
  check. **The panel that renders these rows is not built**; the guard is waiting for U21/U25.
- **The demo API refuses a credential on the query string as well as in the body (V45,
  2026-08-13).** `handleDemoRequest` scanned `request.body` alone while `infra/lambda/demo.ts`
  parses every query parameter and passes it in, so a credential-shaped query parameter was
  ignored and the request honoured with a 200. Nothing leaked — the parameter was dropped, never
  stored — and no credential *field* is declared anywhere, so invariant 8 was never false. What
  failed was `05` §5's **"rejected rather than honoured"**, which exists because a silently
  dropped credential looks exactly like an accepted one. **The path is deliberately still not
  scanned**: a path names a route, not a field, and the router 404s anything it does not know.
  **Two un-deployed source changes now** — this and `ChangefeedFn`'s status filter from V39 —
  and one `node infra/bundle.mjs && npx cdk deploy` clears both.
- **`04` §5 rung 2 is built and forced (U17, V37): `npm run gate:degrade`, 7/7.** A throttled
  Bedrock yields a deterministic local vector, the intent is marked
  (`intents.embedding_degraded`, a `03` §2 addition — `docs/SPEC-DELTA.md`), and dedupe is
  **skipped rather than run with a threshold of zero**, because the show-SQL panel would
  otherwise show a search that §5 says did not happen. `findDuplicate` carries
  `AND NOT embedding_degraded`: a hash vector left in the candidate set corrupts every later
  dedupe decision, long after Bedrock recovers. Forced first because §5 names this the rung
  most likely to fire unnoticed — it is reachable in REPLAY, which caches reasoning but not
  embeddings.
- **Changefeed delivery is proven end to end, not just entitled (V26).** `npm run
  gate:stream` takes a session anonymously from the hosted API, writes one row as
  `cortex_demo`, and receives it back over the WebSocket in ~126ms. V25 established the
  entitlement and refused to claim delivery; that gap is closed. `npm run changefeed
  status|create|cancel` manages the job — `create` cancels existing feeds first, because
  two feeds on one sink double every event on the panel.
- **This account's Lambda concurrency limit is 10, not 1000; it cannot be raised from the
  CLI (V22) and it cannot be subdivided either (V26).** Ten simultaneous visitors already
  get `503`, which `04` §5's ladder forbids and rule B4 makes a submission risk. It is an
  **account-level restriction below AWS's default of 1000**, so
  `request-service-quota-increase` refuses every value that would help
  (`IllegalArgumentException`, must exceed the default), and the Support API needs a paid
  plan this account does not have. Console support case is the only route.
  **`04` §5's brake 1 — reserved concurrency of 2 on the LIVE Lambda — is therefore
  falsified and unimplemented.** AWS refuses any reservation that drops unreserved
  concurrency below 10 and the total is 10, so every value from 1 up is rejected. U14
  substituted nothing; U17 picks the replacement, constrained by §5 to target the LIVE
  reasoning function and nothing else. **Build for 10.** Do not re-attempt either CLI
  path — both have been tried.
- **`cortex_demo` confinement is decided and built (U15, V24, 2026-08-11): row-level
  security on the one cluster.** `04` §3's `[OPEN]` is closed. Every one of the six
  tables carries `FORCE ROW LEVEL SECURITY` plus a policy admitting only rows whose repo
  is an unexpired demo scope **and** the scope named by `cortex.demo_session` on that
  connection. `03` §8 **test 9 exists** and asserts it by attempting the statements.
  Two things to know before touching it: policy expressions on this cluster **cannot
  contain a subquery** (42P01/42703 — that is why `is_current_demo_scope()` exists), and
  every policy is DROP-then-CREATE rather than `IF NOT EXISTS`, because the latter
  silently skips and an edited predicate would never reach a live cluster.
- **The demo plane is a pool of its own, and its scope binds as a parameter (U14, V26).**
  `getPool(plane)` takes `'write'` (`CORTEX_DSN`) or `'demo'` (`CORTEX_DEMO_DSN`) — one
  variable per plane, so no deployment can promote one function's privileges into
  another's. `withRetry(fn, { plane, demoSession })` issues `SELECT set_config(
  'cortex.demo_session', $1, true)`, **not** the `SET` `05` §5 spells out: `SET` takes no
  bind parameter, and restoring it showed a hostile session id reaching the parser and
  attempting `DROP TABLE claims`, stopped only by the grant. `is_local = true` also ends
  the scope at `COMMIT`, so a pooled connection cannot carry one visitor's scope into the
  next request.
- Privilege planes: **verified by attempting writes, V9, resolved 2026-08-09; under
  test since V15 — for two of the three planes.** Reader reads and cannot write;
  `cortex_demo` reaches its own live demo scope and nothing else. Do not re-check this
  with `SHOW GRANTS` or `SHOW POLICIES` — that is the narrow question whose true answer
  hid the admin membership. Attempt the write. `test/privilege-planes.test.ts` is the
  guard rather than the log, and since U15 its demo half is `03` §8 test 9 rather than
  the weaker "no privilege at all".
  **The write plane is the exception, and `/check` found it blind on 2026-08-13 (V40).**
  `src/db/pool.ts:7` says `CORTEX_DSN` is `cortex_writer`; `npm run db:check` says it connects
  as **`julian`**, and there is no `CORTEX_WRITER_DSN` in `.env`. The role exists and V9 proved
  it is refused `DROP` — what is unproven is that this variable names it. The file asserts the
  principal for the reader (`:124`) and the demo plane (`:284`) and for `CORTEX_DSN` opens a
  client it calls `admin` (`:238`), asserting nothing; that missing assertion is the one that
  would have caught this. **"writer writes and cannot `DROP`" is therefore still log-only.**
  Deviation in `docs/SPEC-DELTA.md`; the decision about which principal the write plane should
  be for the recording is open and Julian's. **Suite 338/338 across 29 files, 632.54s against the
  real cluster (2026-08-13, V45)** — 170 after U15 (down from 174 because 13 blanket demo
  assertions became 9 sharper ones, not because anything was removed), U14 added 27, U16
  took it to 249, U16b to 256, V33's `test/recall-truth.test.ts` to 265, V34's skill
  threshold assertion to 266, U17's `test/live-budget.test.ts` plus two privilege-plane
  refusals to 278, `test/degraded-embedding.test.ts` to 297, U21's abandonment tests to 300,
  `test/patches.test.ts` and `test/app-bundle.test.ts` to 316, `test/attribution.test.ts` to 323,
  `test/gate-mechanical.test.ts` to 327, `test/git-hook.test.ts` to 333, and V45's five
  query-string cases in `test/demo-plane.test.ts` to 338.
  **~600s is a cluster health check as much as a suite result** (589s, 608s and 633s on three rested
  runs the same day; that spread is noise, a multiple is not). The same suite on the same tree
  took 2504s and then hung outright on the fourth back-to-back run of one day (V43). A duration
  far off 590s means the cluster is saturated, not that the code changed. **Do not run the suite
  back to back** — one run, then let it rest.
  **It is a rate limit, not a budget.** Julian read the Console on 2026-08-13: **2.81M of 60M
  Request Units, 4.7%**, after two weeks of benchmarks, sweeps, gates, a deployed demo and four
  suite runs in one morning. So nothing needs rationing before ship and the ceiling is not
  reachable at this burn — what is exhaustible is Basic tier's **burst throughput**, which
  refills with rest. The reading is Console-only: `/usage`, `/metrics`, `/usagelimits` and
  `/costs` are all 404 on the Cloud API.
- **`08` §4's end-of-day-two gate is PASSED (U13, V20, 2026-08-10). The project is
  submittable from this moment even if everything else fails.** The table is committed
  under `bench/results/`, median of three runs. **Republished 2026-08-11 (V23) after the
  dedupe threshold moved**, and the numbers improved: `duplicate_work_rate` 0.21 → 0.00,
  `lost_writes` 21 → 0, `conflicting_edits` 3 → 0, `wasted_tokens` 4000 → 867. Quote
  it from that directory, never from memory, and quote the limitations with it —
  `summary.md` carries them and they are load-bearing, not decoration. **One results
  directory only.** The 0.28 run was deleted rather than kept alongside; two published
  tables is a reader guessing which one is quoted.
- Reason model: **resolved and invoked, V18, 2026-08-10.** `.env` sets
  `BEDROCK_REASON_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0`; `npm run
  probe:reason` calls it and it answers correctly in ~3.3s. LIVE reasoning is no longer
  an untested path. Re-run the probe before the recording session — entitlement is an
  account fact and can change without this repository knowing.
- The Cloud service account is sorted: **Cluster Operator**, `CORTEX_MCP_CLUSTER_ID`
  confirmed, `select_query` runs the recall shape (V16, V17). Role assignment turned
  out to be a Console action, contrary to V10's reading of `ccloud-faq.md`.
- **The read path is `cortex_reader`, not the managed MCP server. Decided 2026-08-10,
  and it is settled** — reasoning in `docs/DECISIONS.md`, measurement in V17. That
  server executes as `managed-mcp`, which holds INSERT and DELETE on `claims`;
  confirmed by invoking `insert_rows` and getting **23502**, not **42501**. `04` §1,
  §3, §4 and `05` §3, §4, §6 are corrected in place. `CORTEX_MCP_*` remains in `.env`
  as diagnostics for `npm run probe:read` only — do not reintroduce that server as the
  route without re-running the probe.
- U10 is **done** (V21): `skills/cortex-memory/SKILL.md` ships recall SQL against
  `CORTEX_READER_DSN`, pinned byte-for-byte against `src/memory/recall.ts` — which now
  exports `RECALL_SQL` for that purpose. Editing the query in either place fails
  `test/skill.test.ts`; both `repo_id` predicates are asserted separately, because the
  equality alone would pass if someone edited both files together (V14).
- **The benchmark harness is deterministic by serialising, and that bounds what two of
  `06` §3's metrics can say** (V19, `docs/DECISIONS.md`). One step runs at a time on a
  simulated clock, so contention is real and reproducible — agent B genuinely finds
  agent A's row in `claims` — but two transactions never overlap. `serialization_retries`
  is therefore 0 by construction and `claim_p50` is an uncontended latency. Report them
  as what they measure. The real race is proven by `npm run gate:contend` (U6) and by
  `test/retry.test.ts` (V13); do not restate either as a benchmark result.
- **The dedupe threshold was the one number the benchmark said to change, and it is now
  changed. `03` §4.2's `[OPEN]` is closed at `0.39` (2026-08-11, V23).** The sweep puts
  the perfect band at (0.3630, 0.4293); 0.39 catches all 6 declared pairs with 0 false
  positives, where the previous 0.28 caught 4. **It is deliberately not 0.40**, which is
  `JUDGE_THRESHOLD` in `bench/metrics.ts` — the judge scores the benchmark that justifies
  the mechanism's value, and one shared constant would read as the two being tuned
  together. What `06` §3 forbids is the benchmark *quietly* tuning the mechanism it
  scores; the defence is disclosure, and `summary.md` publishes the sweep, the old value,
  the new one, and the fact that one followed the other.
- **`bench/cassettes/` is committed and is the reproducibility claim.** Replay reaches
  no network at all — the run record carries `liveCalls: {embed: 0, reason: 0}` and a
  cassette miss is a hard error, never a fall-through to Bedrock. Re-record with
  `npm run bench -- --record`, which prefetches every task rather than recording what a
  run happened to touch. Editing a fixture or a task statement changes the prompt and
  so changes the key: expect a `CassetteMiss`, and re-record rather than loosening it.

---

## How to work here

`spec/11-SHIP-LOOP.md` is the process. The short version:

- One unit at a time, from `docs/UNITS.md`. Do not pick your own scope.
- Never load more than three spec files at once.
- Tests for the §8 invariants first; they must fail before the implementation exists.
- Commit after every green unit: `type(scope): description`. No `Co-Authored-By`.
- Stuck twice on the same problem → STOP, explain the blocker, propose options.
- Do not refactor outside the current unit's scope.

## Rules that have already been broken once

Each of these cost real time. They are here because reasoning did not catch them —
only checking did.

- **If the spec contradicts observed behaviour, STOP and report.** Do not reconcile
  silently in code. Three spec claims have been falsified so far (V1 opclass, V5
  index isolation, Bedrock v5 entitlement), and every one of them read as obviously
  true until it was invoked.
- **Do not assert in a comment or a doc what the tests do not check.** If a comment
  claims an invariant, there is a test for it or the comment is a lie.
- **Correct documents in place; never append a contradiction.** When something
  resolves, edit the line that said it was open. A log that accumulates
  contradictions is worse than no log, because it still looks authoritative.
- **A catalogue listing is not an entitlement, and an EXPLAIN plan is not a
  guarantee.** Invoke it, or write TBD.
- **Never write a placeholder number.** Write TBD.
- **Never paste a credential-shaped string into a file — including into a doc, a comment, a
  test fixture, or a pasted `--report` FAIL line.** Describe it; quote the verdict and the exit
  code, not the string. This was broken **four times in one session** on 2026-08-13 (V42, V43),
  each time by copying the gate's own output into the log or a test, each time discovered only
  after the commit. `scripts/gate-mechanical.sh` predicted it in its own comment before any of
  them. The check catches it every time — that is not the problem.
- **Run `bash scripts/gate-mechanical.sh --report` yourself before every commit.** The
  `PreToolUse` hook did not fire in the 2026-08-13 session (V42) and the script is not why: hook
  mode blocks correctly when invoked directly. A hook that silently does not run looks exactly
  like a hook that passed, so do not rely on being stopped.
  **The `PreToolUse` hook was later seen firing again the same day (V42, V45) — so it is
  intermittent, not dead, which is worse to rely on than either.**
  **Since V44 there is a second, harness-independent route** — `.githooks/pre-commit`, which git
  runs itself and which blocks an agent's commit while never blocking Julian's (`CLAUDECODE` is
  set in one shell and not the other, which is `scripts/gate-mechanical.sh`'s own stated split
  made executable). It needs **one command per clone**, and `test/git-hook.test.ts` fails with
  that command as its message if it is missing: `git config core.hooksPath .githooks`. Still run
  `--report` yourself — the hook is a guard against forgetting, not a reason to stop looking.
- **Verify against the real cluster.** A mock, an in-memory DB, or a local
  single-node stand-in does not count and fails `/check`.

## Invariants that must never regress

Tests live in `test/`. **This list is not `spec/03-MEMORY-MODEL.md` §8's list, and saying it
was cost a `/check` row its clarity (V40).** §8 is *"What must be tested"* and has **nine**
items; the eight below are the invariants, drawn mostly from §4.2. Both numberings are in live
use across `test/`, cited as **"§8 test N"** for §8's nine and **"invariant N"** for these
eight. The collision has already mis-fired once — `test/skill.test.ts:84` cites "§8 test 8" for
the no-credential rule, where §8 item 8 is recall tenant isolation. Nothing behavioural depends
on it; do not renumber either list to fix it, because every existing citation would then be
wrong. All nine of §8's items have a test (the map is in V40).

1. Dedupe and claim share **one** transaction. If a similarity check and a claim
   insert ever land in different transactions, connections, or requests, the
   project's thesis is falsified by its own code.
2. All or nothing on claim acquisition — never a strict subset of the keys asked for.
3. A blocked agent learns the holder and its intent, so it can re-plan rather than poll.
4. A deduped agent receives the prior outcome, not a rejection.
5. Every read carries `WHERE repo_id`. The vector index prefix does **not** isolate
   tenants — V5 measured it falling back to a full scan and returning another repo's
   rows. A forgotten filter fails open.
6. Every write path is wrapped in the 40001 retry helper.
7. No agent-reachable path accepts SQL, a table name, or any structural parameter.
8. No credential field on any demo surface, under any name, including commented out
   or feature-flagged off.

## Stack

Node + TypeScript, `pg` against CockroachDB Cloud (Basic tier, `agent-hack-30704`,
`aws-us-east-1`). Vitest, run against the **real** cluster via `CORTEX_DSN`.
ESM throughout — `"type": "module"`, and relative imports carry `.js`.

`npm test` · `npx tsc --noEmit` · `npm run db:check` · `npm run sql` ·
`npm run env:doctor` · `npm run serve` (MCP on stdio) · `npm run gate:contend` ·
`npm run gate:stream` (hosted; needs the deployed stack and a running changefeed) ·
`npm run gate:consolidate` (hosted) · `npm run gate:degrade` (forces `04` §5 rung 2) ·
`npm run changefeed status|create|cancel` ·
`bash scripts/gate-mechanical.sh --report` (`/check` row 4; also runs as the commit hook) ·
`npm run deploy:secrets` · `npm run deploy:site` · `npm run sweep:recall` (live Titan +
cluster `<=>`; republishes the recall threshold table) · `npm run measure:statements` (live
Titan + cluster `<=>`; every pairwise distance between demo statements — **run it after any
rewording**, design §3 and V38).

`npx tsc --noEmit` exits clean and must stay that way — it is what someone cloning
the repo runs first, and Production Readiness is scored.
