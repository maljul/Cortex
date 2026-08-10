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
- Open: the `cortex_demo` confinement mechanism (`04-ARCHITECTURE.md` §3), narrowed
  by V5 — it cannot rest on the vector index prefix. Since V9 it starts from zero
  privilege rather than from admin, which is the right direction to grant from.
- Privilege planes: **verified by attempting writes, V9, resolved 2026-08-09; under
  test since V15.** Reader reads and cannot write; writer writes and cannot `DROP`;
  `cortex_demo` can do nothing. Do not re-check this with `SHOW GRANTS` — that is the
  narrow question whose true answer hid the admin membership. Attempt the write.
  `test/privilege-planes.test.ts` is now the guard rather than the log; the reader
  half is green, the demo half is red on a missing credential (below).
  `CORTEX_DEMO_DSN` arrived 2026-08-10 and the demo half is green too: `cortex_demo`
  cannot read or write any of the six tables. **Suite 168/168.**
- **`08` §4's end-of-day-two gate is PASSED (U13, V20, 2026-08-10). The project is
  submittable from this moment even if everything else fails.** The table is committed
  under `bench/results/`, median of three runs: `duplicate_work_rate` 0.21 → 0.08,
  `lost_writes` 21 → 0, `conflicting_edits` 3 → 0, `wasted_tokens` 4000 → 1975. Quote
  it from that directory, never from memory, and quote the limitations with it —
  `summary.md` carries them and they are load-bearing, not decoration.
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
- U10 is **unblocked** and reshaped: the skill ships recall SQL against
  `CORTEX_READER_DSN`, pinned byte-for-byte against `src/memory/recall.ts` by a test,
  because both `repo_id` predicates must survive retyping (V14). It is still not the
  critical path — `08` §4's end-of-day-two gate is U13's summary table.
- **The benchmark harness is deterministic by serialising, and that bounds what two of
  `06` §3's metrics can say** (V19, `docs/DECISIONS.md`). One step runs at a time on a
  simulated clock, so contention is real and reproducible — agent B genuinely finds
  agent A's row in `claims` — but two transactions never overlap. `serialization_retries`
  is therefore 0 by construction and `claim_p50` is an uncontended latency. Report them
  as what they measure. The real race is proven by `npm run gate:contend` (U6) and by
  `test/retry.test.ts` (V13); do not restate either as a benchmark result.
- **The dedupe threshold is the one number the benchmark says to change, and it has not
  been changed.** `src/memory/propose.ts` ships `0.28`, which catches 4 of the corpus's
  6 declared pairs; the sweep puts the perfect band at (0.3630, 0.4293). That is why
  CORTEX's `duplicate_work_rate` is 0.08 and not 0.00. Editing the constant inside the
  unit that scores it is the circularity `06` §3 forbids — `03` §4.2's `[OPEN]` is
  Julian's to close, with `bench/results/*/threshold-sweep.md` in front of him.
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
`npm run env:doctor` · `npm run serve` (MCP on stdio) · `npm run gate:contend`.

`npx tsc --noEmit` exits clean and must stay that way — it is what someone cloning
the repo runs first, and Production Readiness is scored.
