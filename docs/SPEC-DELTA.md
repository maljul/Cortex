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

Since then the four purely mechanical rows of the gate — typecheck, SQL containment,
`.env` ignored, credentials — have left the prompt entirely for
`scripts/gate-mechanical.sh`, which `/check` calls with `--report` and a PreToolUse
hook calls on every commit made through Claude Code. §2 assumes the gate is a prompt
an agent reads; four of its rows are now a process that exits 2.

**Not edited in the spec, deliberately.** §5's `/clear` discipline — fresh context
before working a unit and again before gating it — still holds and is the load-bearing
part of §2; only the command names moved. A reader following §2 literally will look for
files that are not there.

---

### `05` §1 and `03` §4.2 name the same decision fields differently

§1 types the value an agent receives as `{ decision: 'deduped'; ofIntentId; holder;
outcome }` and `contested: Array<{ key; holder; intentId }>`. §4.2's application rule
writes the same value as `{ decision: 'deduped', of, holder, outcome }`, and the SQL
it returns names the column `resource_key`. Neither section acknowledges the other.

Both are honoured, in the place each is about. `src/memory/propose.ts` kept §4.2's
names because it *is* §4.2's transaction. The MCP boundary answers in §1's, because
§1 is where the shape an agent codes against is written down, and U10's Agent Skill
will tell agents how to react to each decision. The translation is six lines in
`src/mcp/server.ts` and is the only place the two vocabularies meet.

§1's `Decision` is also incomplete rather than wrong: it has no `distance` on a
dedupe, no `status`, and no `expiresAt` on a contested key. The tool adds all three
and renames none. The last one is not cosmetic — without it a blocked agent knows who
holds the key but not for how long, which decides whether re-planning or waiting is
correct, and invariant 3 exists to make that judgement possible.

### `05` §3 advertises `glob:` keys that §6 gives the server no way to expand

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
