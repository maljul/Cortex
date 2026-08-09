# CORTEX

## Current state (update every session)

- Verification gate: **5/5** — Bedrock resolved 2026-08-09, embeddings PASS (1024
  dims), v5 reasoning models NOT entitled on this account; reason model reassigned
  to `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
- Done: schema, retry helper, typed layer, arbitration + invariants 1–8, CLOSE, RECALL
- Off-plan: `src/extract/graph.ts` (belongs to consolidation, §4.4 — **do not extend**)
- Next: U5 embeddings + content-hash cache, then U6 the two-terminal day-one gate
- Open: `cortex_demo` confinement mechanism (`04-ARCHITECTURE.md` §3), narrowed by V5

Unit list and ordering: `docs/UNITS.md`. Evidence for every claim above:
`docs/verification-log.md`.

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
  single-node stand-in does not count and fails `/lh-gate`.

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
`npm test` · `npm run db:check` · `npm run sql` · `npm run env:doctor`.
