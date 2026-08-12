# CORTEX

## Current state

**`docs/UNITS.md` is the status of record.** What is done, what is next, and why
anything was deferred lives there and only there. This block used to duplicate it
and the two drifted within a day, which cost a unit of ambiguity over whether U2 or
U7 came next. Do not reintroduce a unit list here.

- Unit status, ordering, next unit → `docs/UNITS.md`
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
  its own dedupe search and its own claim insert. **The SPA is built and deployed**
  (`infra/site/index.html`, V29); what is unconfirmed is whether it *reads* — see
  `docs/UNITS.md` U16.
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
- **LIVE reasoning is not built and is blocked on two decisions.** `04` §5 brake 2's global
  run counter has nowhere to live but a **new table**, and `03` §2's six are the memory
  model — that is a stop-and-ask. And the actual Bedrock rate for Sonnet 4.5 is **TBD**: two
  fetches of AWS's pricing page did not return it, and this repository does not write
  placeholder numbers. Do not enable LIVE until both are closed.
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
  test since V15.** Reader reads and cannot write; writer writes and cannot `DROP`;
  `cortex_demo` reaches its own live demo scope and nothing else. Do not re-check this
  with `SHOW GRANTS` or `SHOW POLICIES` — that is the narrow question whose true answer
  hid the admin membership. Attempt the write. `test/privilege-planes.test.ts` is the
  guard rather than the log, and since U15 its demo half is `03` §8 test 9 rather than
  the weaker "no privilege at all". **Suite 266/266 across 22 files, 482s against the real
  cluster (2026-08-12, V34)** — 170 after U15 (down from 174 because 13 blanket demo
  assertions became 9 sharper ones, not because anything was removed), U14 added 27, U16
  took it to 249, U16b to 256, V33's `test/recall-truth.test.ts` to 265, and V34's skill
  threshold assertion to 266.
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
- **Verify against the real cluster.** A mock, an in-memory DB, or a local
  single-node stand-in does not count and fails `/check`.

## Invariants that must never regress

From `spec/03-MEMORY-MODEL.md` §8. Tests live in `test/`.

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
`npm run gate:consolidate` (hosted) · `npm run changefeed status|create|cancel` ·
`npm run deploy:secrets` · `npm run deploy:site` · `npm run sweep:recall` (live Titan +
cluster `<=>`; republishes the recall threshold table).

`npx tsc --noEmit` exits clean and must stay that way — it is what someone cloning
the repo runs first, and Production Readiness is scored.
