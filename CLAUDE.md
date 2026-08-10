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
- Privilege planes: **verified by attempting writes, V9, resolved 2026-08-09.** Reader
  reads and cannot write; writer writes and cannot `DROP`; `cortex_demo` can do
  nothing. Do not re-check this with `SHOW GRANTS` — that is the narrow question whose
  true answer hid the admin membership. Attempt the write.
- Reason model: **resolved 2026-08-10.** `.env` now sets
  `BEDROCK_REASON_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0`, which is the
  entitled one; `npm run env:doctor` no longer warns. Nothing reads it yet, so LIVE
  mode is still unproven end to end — that is day three's job, not this line's.
- **Action for Julian, blocking U10:** the Cloud service account behind
  `CORTEX_MCP_API_KEY` has no roles — `list_clusters` returns zero rows, so every SQL
  tool answers `unauthorized` (V10). Cloud's default is Organization Member, which
  adds no permissions, and service-account roles are **Cloud-API-only**, not a Console
  action. Assign it a cluster-scoped role, then `npm run probe:read`.
- **Open, and larger than U10:** the managed MCP server publishes `insert_rows`,
  `create_table` and `create_database` (V10). `04` §2 routes reads there *because*
  that path is supposed to be governed. Whether those tools reach `claims` and
  `intents` is **TBD** until the role above exists. If they do, the read path is an
  unarbitrated write path and `04` §2 needs rethinking, not documenting around.

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
