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
  `cdk-spike/`) deploys stack `CortexStack`: **five** Lambdas behind API Gateway HTTP (U22 added
  the runner), a WebSocket API, a DynamoDB connection registry, S3 + CloudFront. IaC is **CDK** — `04`
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
- **LIVE reasoning is built, deployed, metered and braked (U17 + U24, 2026-08-16).** `04` §5
  brake 2's global run counter is built on a **seventh table**, `live_run_budget` — Julian's
  call, reasoning in `docs/DECISIONS.md`. It carries no `repo_id` because §5's counter is
  global, and that exemption from invariant 5 is asserted against `information_schema` so it
  cannot widen. `cortex_demo` reaches today's row and no other day, and holds no DELETE.
  **The cap is not a literal: `LIVE_RUNS_PER_DAY` is derived in `src/memory/live-budget.ts`**
  as `LIVE_BUDGET_USD` ÷ the cost of one metered run. It was a written `10` until U24 and is
  **30** now, from a real two-arm LIVE run on 2026-08-16 — **16 model calls, 36,892 input and
  10,255 output tokens** off Bedrock's own `usage`, **$0.2910 a run** at the measured rate. If
  the metered run were `null` or free the cap computes to **0** and LIVE is simply off.
  The rate is **$3.30 per 1M input, $16.50 per 1M output**, taken from this account's own
  billing after AWS's pricing page failed twice (V30) and its **Price List API turned out not
  to carry Sonnet 4.5 at all**. §5's own default of 40 a day is hundreds of dollars across the
  judging window against its own "single-digit dollars" — the deviation is in
  `docs/SPEC-DELTA.md`. **Cost Explorer bills reasoning under `Claude Haiku 4.5 (Amazon Bedrock
  Edition)` and `Claude Sonnet 4.5 (Amazon Bedrock Edition)`, services distinct from `Amazon
  Bedrock`** — and brake 3's Budget filters on those two names, because `Amazon Bedrock`
  carries only the Titan line and a Budget on it would never fire.
  **LIVE runs on exactly one function.** `LiveReasoningPolicy` allows `bedrock:InvokeModel` on
  Claude Haiku 4.5 by ARN and is attached to the fleet runner's role and nothing else;
  `LiveReasoningDenyPolicy` mirrors it ARN for ARN with Effect Deny and is attached to nothing
  until brake 3 fires. **Brake 3 is armed:** AWS Budget `cortex-live-reasoning`, **$9 ANNUAL**
  — annual because the judging window spans two calendar months and a monthly $9 permits $9
  twice — action `APPLY_IAM_POLICY`, AUTOMATIC, status STANDBY. It is a **bound, not an
  interlock**: Budgets evaluate cost data that refreshes a few times a day, so spend can
  overshoot inside one refresh window. **Brake 1 stays falsified** — AWS refuses a concurrency
  reservation at every value on this account — and its intent is met by three things instead: the
  global counter bounds spend, the account's own 10-slot concurrency ceiling bounds fan-out,
  and detaching `LiveReasoningPolicy` stops model calls and nothing else.
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
  have vetoed this silently while the unit test passed. **Deployed and proved live 2026-08-13
  (V46).** `npm run gate:consolidate` is now 8/8 and its checks 5-8 abandon a second intent on a
  different file: before this the gate closed only as `done` and would have passed identically
  either side of the deploy, which is not evidence.
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
  check. **The runner supplies that since U21; the panel that renders the rows is U25's.**
  **Scope: this covers interlock 3 of five.** Four of the five interlocks leave every patch
  present in both trees — they are cross-module compositions, not absences — so
  `inCortex && !inNaive` is correctly false for all of them.
  Attribution for those needs a second axis — *which two correct changes compose wrongly* — and
  no code has it. Do not present this module's output as complete attribution; details and the
  table are in `docs/UNITS.md` under U21.
- **The workload runner is built and the demo is a real ten-task two-arm run (U21, V50,
  2026-08-13).** `npm run gate:workload` is the proof: **17/17**, eleven tickets to completion in
  both arms against the real cluster, all four beats *observed* rather than scripted, and four of
  the five interlocks producing their defect. `src/demo/workload.ts` is the runner;
  `src/memory/naive-lane.ts` is the conventional stack it is compared against;
  `bench/demo-app/` is the corpus — **fourteen files across seven modules**, plain scripts in a
  dependency load order with no imports, no network and **no input element**, so a tree assembles
  into an `iframe` document and invariant 8 has nothing to argue about.
  **The naive lane's lock locks the ticket, not the file** — Julian's call; a job lock is what
  that stack takes and is exactly what cannot see two tickets colliding in one file. It runs the
  **same** dedupe statement and the **same** claim statement as `propose()` (both now exported
  from `src/memory/propose.ts`, one literal each) in **two** transactions where `propose()` uses
  one. `test/naive-lane.test.ts` counts the `BEGIN`s and fails if they ever become one.
  **Two silent breaks were found by running it and by nothing else**, both now assertions about
  `ASSIGNMENT`: a *sequenced* dedupe pair is deduplicated by the naive lane too (its search works
  fine against an intent that committed a second ago — U16b's "beat 2 is a sequence" precedent
  does not transfer, because U16b's naive arm had no dedupe), and an intent that **never closes**
  stays a dedupe candidate for ever, which had the naive lane dedupe the eleventh ticket at
  0.3686 against a task that was *given up on*. The naive lane now closes; the findings the sink
  writes into its scope are never read, because that stack has no step that consults an outcome.
  **There is no `meter.field += 1` in the runner**: every figure is a filter over `steps`/`events`,
  a subtraction over a readback, or a distance the cluster computed, and `test/workload.test.ts`
  forbids an increment in any form — stricter than the rule it inherits.
  **A full run costs 24 rows in the cortex scope and 32 in the naive one** against
  `DEMO_SESSION_ROW_CAP = 200`, so the cap does not move.
  **The runner makes no model call**, deliberately: which patch variant an informed agent applies
  is decided by comparing what `recall()` returned against what consolidation wrote, exactly. So
  `07` §4's mode line keeps its wording and cassettes are not re-recorded — `docs/SPEC-DELTA.md`.
  **Two of the gate's 17 checks are race-dependent: a run can honestly come back 15/17** (V51).
  When the naive lane's dedupe catches the racing P6 pair, interlock 4 does not happen and its
  absent hunk reads as an unattributable loss. Re-run before calling a red gate a regression.
- **`06` §3's `conflicting_edits` exists for the first time, and it cannot see this lane's own
  loss mode — so a second figure sits beside it (U23, V52, 2026-08-13).** `src/demo/conflicts.ts`.
  §3's metric is **line-granular** and computed exactly as `bench/metrics.ts` computes it, so the
  demo's number and the published benchmark's mean the same thing on one page. Beside it,
  **`fileCollisions`** — agent pairs writing one file in overlapping windows, whatever their lines
  — because `shared-state.ts` writes back **per file**. Live: **naive 3, cortex 0**, where §3's own
  rule reports **0 for both**, since interlock 3's three agents edit *disjoint regions* of
  `orders/repository.js`. Julian's call was to publish both under separate names rather than bend
  §3, whose meaning the committed benchmark owns. **A collision window is read→save inclusive of
  the save**: ticket-to-save reported a collision in the *cortex* lane (a blocked agent waiting is
  not a collision) and read-to-patch reported zero beside a lost hunk (a lost write requires
  someone to have read before another's write landed). `npm run gate:workload` caught both.
  **`ArmResult` carries the spans the figures are computed over** and the gate asserts they are
  non-empty, because a count over an empty list renders exactly like a count over real work —
  `06` §6's rule applied to a count rather than a rate.
  **The guard the done-when rests on was itself broken:** `test/workload.test.ts` claimed adding an
  `ArmMeter` field without listing it would fail, and nothing checked it — the assertion ran the
  other way, so any *new* meter figure could be rendered from a literal with the file green. The
  list is now derived from `ArmMeter`'s declaration.
  **Design §8's artifacts need no sixth route and no new storage:** `GET /demo/state` returns
  `files`, projected from the `demo_shared_state` cell it already read. `null` before any agent
  saves; live it is 14 files per arm.
- **The run is asynchronous and streamed, and the design's reason for it was measured false
  (U22, V51, 2026-08-13).** `npm run gate:async` is the proof, 13/13 against the deployed stack:
  `POST /demo/run` answers **482ms** against a **30,000ms** gateway ceiling and the whole run —
  87 fleet events, one terminal message, nothing after it — arrives over the existing WebSocket.
  **Design §5.1 said a two-arm run would exceed the ceiling. It does not.** A runner deployed
  synchronously *on purpose* to take the 504 answered in **4548ms**; the run itself is **5943ms**.
  Deployed in-region it is **6–9s** where the identical run from a laptop is ~50s — round-trip
  latency over ~350 statements per arm, not work. **So every wall-clock number in this repository
  for the workload, U21's 28–42s included, is a laptop-to-cloud figure and says nothing about what
  a visitor waits.** The shape stayed and every comment citing the ceiling was rewritten in place,
  on three reasons that survive: the stream *is* the demo (§9 wants the collision watched), U24's
  LIVE mode at ~50 model calls will exceed 30s alone, and `07` §1 budgets ninety seconds.
  **`POST /demo/run` gained a `mode`, not a sixth route** — design §8 refuses one, and decision 7
  keeps the deployed page serving, so the four-beat response is still the default and is guarded
  live. **`POST /demo/session` now creates two scopes** and `sessionId` *is* the cortex one, not a
  third `repos` row. **The terminal event has two paths and only one is a throw** — the other is
  the Lambda timeout, which runs no `finally` — so the watchdog is in `streamRun` where
  `test/run-stream.test.ts` forces it with a 60ms budget. **`pg`'s demo pool max is 10 and ten
  overlapping transactions commit in 2497ms**, so no two-wave fallback is needed; the arms still
  run sequentially so neither arm's `claim_p50` is measured under the other's load.
  **`import.meta.url` is empty under esbuild's CJS**: `bench/demo-app/` is copied next to the
  handler and `CORTEX_CORPUS_ROOT` names it, or the runner deploys clean and throws on first read.
- **A fact is reachable only if it names the work, not the change (V49, and V39 found it first).**
  Measured twice on unrelated pairs. An abandonment note naming the *obstacle* sits 0.6725–0.7246
  from the task it warns; the restatement naming the *work* sits 0.4698. A closure note naming a
  *change* ("a cache was added") sits **0.8459** from the task the change endangers; naming the
  **affected work** sits **0.3633**. Recall reaches 0.60, so the obvious phrasing is memory nobody
  can find. `npm run measure:statements` carries an `INTERLOCK REACHABILITY` section that measures
  this and a `FACT SEPARATION` section — two of a run's facts closer than `CONSOLIDATION_DISTANCE`
  collapse into one finding carrying two corroborations for two events. **Re-run it after
  rewording a closure note, not just a statement.**
- **The demo API refuses a credential on the query string as well as in the body (V45,
  2026-08-13).** `handleDemoRequest` scanned `request.body` alone while `infra/lambda/demo.ts`
  parses every query parameter and passes it in, so a credential-shaped query parameter was
  ignored and the request honoured with a 200. Nothing leaked — the parameter was dropped, never
  stored — and no credential *field* is declared anywhere, so invariant 8 was never false. What
  failed was `05` §5's **"rejected rather than honoured"**, which exists because a silently
  dropped credential looks exactly like an accepted one. **The path is deliberately still not
  scanned**: a path names a route, not a field, and the router 404s anything it does not know.
  **Deployed and proved live 2026-08-13 (V46):** the same `curl` returns 404 before and
  `400 {"field":"query.dsn"}` after, with a plain `?session=` still routing normally.
- **`04` §5's whole ladder is built and forced: `npm run gate:ladder`, 36/36 — all four rungs,
  a rung 1b, and all three brakes.** Rung 1b forces the runtime shape of brake 3's IAM Deny: the
  `bedrock:InvokeModel` grant refused, the fleet completing anyway on reviewed patches.
  **Rung 2 was the first one forced (U17, V37) and was 7/7 on its own.** A throttled
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
- Privilege planes: **all three verified by attempting the statement, and all three under test.**
  Reader reads and cannot write; **writer writes and cannot `DROP`, `ALTER` or `CREATE INDEX`**;
  `cortex_demo` reaches its own live demo scope and nothing else. Do not re-check this with
  `SHOW GRANTS` or `SHOW POLICIES` — that is the narrow question whose true answer hid the admin
  membership. Attempt the write. `test/privilege-planes.test.ts` is the guard rather than the
  log, and since U15 its demo half is `03` §8 test 9 rather than the weaker "no privilege at all".
  **The write plane was the exception until 2026-08-13 and is not any more (V40 → V48).**
  `src/db/pool.ts` claimed `cortex_writer` for months while reading `CORTEX_DSN`, which is
  `julian`, a cluster admin — and it survived because this file asserted the *reader's* and the
  *demo's* principal and, for the write plane, opened a client it merely called `admin`.
  `/check` found it blind. The plane now reads **`CORTEX_WRITER_DSN`**; the credential was proved
  to log in (V9 only ever used `SET ROLE`, which proves grants and not authentication) and proved
  to be refused all three DDL forms with **42501**, with `findings` at 852 rows before and after.
  **`CORTEX_DSN` stays and stays admin, deliberately:** `scripts/sql.mts` and
  `scripts/changefeed.mts` need DDL and job control and are the only two that do (V47 measured
  it — 35 candidate breakages, 14 surviving refutation, all administrative). One variable doing
  both jobs is how this went wrong.
  **What it buys, honestly: nothing against `04` §3's own threat** — every `writer_all` policy is
  `USING (true) WITH CHECK (true)`, so the same rows are reachable either way, and invariant 7
  already blocks the agent-reachable path. It buys that the published table is true, and a test
  holds it there.
  **Suite 423/423 across 34 files, 629.83s against the
  real cluster (2026-08-13, V52)** — 170 after U15 (down from 174 because 13 blanket demo
  assertions became 9 sharper ones, not because anything was removed), U14 added 27, U16
  took it to 249, U16b to 256, V33's `test/recall-truth.test.ts` to 265, V34's skill
  threshold assertion to 266, U17's `test/live-budget.test.ts` plus two privilege-plane
  refusals to 278, `test/degraded-embedding.test.ts` to 297, U21's abandonment tests to 300,
  `test/patches.test.ts` and `test/app-bundle.test.ts` to 316, `test/attribution.test.ts` to 323,
  `test/gate-mechanical.test.ts` to 327, `test/git-hook.test.ts` to 333, and V45's five
  query-string cases in `test/demo-plane.test.ts` to 338. U22's `test/run-stream.test.ts` (8) and
  five live route cases in `test/demo-plane.test.ts` took 397 to 410, and U23's
  `test/conflicts.test.ts` (12) plus the artifact case took it to 423.
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
  **And a clean clone actually reproduces it now — run, not reasoned about (U18, V57,
  2026-08-16).** Clone to an empty directory, `npm ci`, `npx tsc --noEmit`, `npm run
  bench:results`: every coordination row is identical, only `claim_p50` (732 → 778) and
  `claim_p95` (818 → 967) move, and both arms record `mode=replay` with
  `liveCalls: {embed: 0, reason: 0}`. **The run found what reading had not: the committed
  `summary.md` named `CORTEX_DSN` as the only prerequisite, and the CORTEX arm runs on
  `CORTEX_WRITER_DSN`** — so a judge configuring exactly what the artifact asked for would
  have watched that arm fail. `scripts/bench-results.mts` was fixed on 2026-08-13 and the
  artifact was never regenerated, so the fix reached the generator and not the file anybody
  reads. Corrected in place; **no published number moved.**
- **`05` §6's config contract is three variables behind the code, and `.env.example` with
  it (V57).** §6 still captions `CORTEX_DSN` the write plane, omits `CORTEX_WRITER_DSN` and
  `CORTEX_CORPUS_ROOT`, and lists `CORTEX_LEASE_TTL`, which has had no reader since U9 cut
  lease extension. `docs/SPEC-DELTA.md` carries it. **`.env.example` is still wrong and is
  the file a newcomer copies** — it is behind a read/write deny rule, so the corrected
  version could not be written from a session; the README's variable table carries the true
  set in the meantime.
- **The public docs are written and the diagram is corrected (U18, V57).** `README.md`,
  `LICENSE` (**MIT** — Julian's call 2026-08-13, settling `package.json`'s ISC against `02`
  B2 and `09` §1; all four places now agree), `docs/architecture.md`, `docs/third-party.md`.
  **Five factual errors were found in the diagram by reading the CDK stack rather than the
  prose beside it**, the load-bearing one being Claude Sonnet 4.5 drawn inside the AWS
  boundary while every `bedrock:InvokeModel` grant was scoped by ARN to the Titan embedding
  model. Depicting LIVE reasoning as wired when it is not is what A7 forbids.
  **That correction was itself overtaken on 2026-08-16 and `docs/architecture.md` carries the
  new state.** `LiveReasoningPolicy` grants `bedrock:InvokeModel` on Claude Haiku 4.5 by ARN to
  the fleet runner's role, so "no deployed function can invoke a reasoning model" is now
  **false** — it is exactly one function — and AWS Budgets and rungs 1, 3 and 4 are built rather
  than "not built". If a doc anywhere still says otherwise, read the CDK stack and correct it.
  `README.md`'s command table still describes `gate:degrade` as forcing only the
  embedding-throttle rung, which is the whole ladder now.
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
- **`BUNDLE_REVISION` proves a deploy landed. It does not prove the deployed bundle matches the
  tree, and on 2026-08-17 that gap served the headline claim inverted.** The marker is bumped by
  hand when a *handler* file is edited. A fix to a file that is merely **bundled into** a handler
  changes deployed behaviour while the marker does not move — `e35cacc` edited
  `src/demo/workload.ts`, the runner's `BUNDLE_REVISION` read 4 on both sides of it, the
  deployed bundle had been built twenty-five minutes before the fix existed, and the public URL
  went on reporting CORTEX losing more writes than the naive lane until it was redeployed the
  next day. The check that works is downloading the deployed artifact and grepping it
  for the fix's own symbol: `aws lambda get-function`, unzip, `grep -c <symbol>` — 0 before, 4
  after. Do that after every deploy that fixes behaviour, not just after one that edits a
  handler.
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
`npm run gate:consolidate` (hosted; 8/8 — checks 5-8 are the abandoned path, V46) ·
`npm run gate:ladder` (36/36 — forces all four of `04` §5's degradation rungs, a rung 1b, and all
three brakes; `npm run gate:degrade` is an **alias for the same script**, kept because that name
is cited across `docs/`. Add `-- --meter` to perform one real LIVE run and derive the cap from
Bedrock's own `usage`; **only `--meter` calls a reasoning model** — the plain run spends
embeddings and cluster time and nothing else) ·
`npm run gate:workload` (U21's and U23's done-when; 20/20, but **two checks are race-dependent and
18/20 is an honest run** — V51 — two scopes, both arms, four beats, ~60s of live cluster time *from here*
and 6–9s deployed, and it needs a **running changefeed** or beat 4 honestly reports nothing known) ·
`npm run gate:async` (U22's done-when; hosted, 13/13 — needs the deployed stack and a running
changefeed; times `POST /demo/run` against the gateway ceiling and reads the whole run off the
socket) ·
`npm run changefeed status|create|cancel` ·
`bash scripts/gate-mechanical.sh --report` (`/check` row 4; also runs as the commit hook) ·
`npm run deploy:secrets` · `npm run deploy:site` · `npm run sweep:recall` (live Titan +
cluster `<=>`; republishes the recall threshold table) · `npm run measure:statements` (live
Titan + cluster `<=>`; every pairwise distance between demo statements — **run it after any
rewording**, design §3 and V38).

`npx tsc --noEmit` exits clean and must stay that way — it is what someone cloning
the repo runs first, and Production Readiness is scored.
