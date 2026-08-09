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

**Not edited in the spec, deliberately.** §5's `/clear` discipline — fresh context
before working a unit and again before gating it — still holds and is the load-bearing
part of §2; only the command names moved. A reader following §2 literally will look for
files that are not there.

---

## Corrected in the spec already — do not re-open

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
