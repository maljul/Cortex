# 11 — Ship Loop

A minimal execution loop to replace the GSD phase cycle **for this build only**.

## Why not GSD here

GSD is not slow. It is **front-loaded**. Its expensive half is discuss, research and
plan — three of the five phases — and that half produces exactly the artifacts that
already exist in this spec package. Running the full loop would re-derive `CONTEXT`,
`RESEARCH` and `PLAN` files from documents that were written specifically so those
phases could be skipped, and pay subagent orchestration cost on every phase to do it.

The half of GSD that is still worth keeping is the discipline of **a fresh context per
unit of work** and **a gate that must pass before moving on**. This loop keeps those
two and drops everything else.

Keep GSD installed. Use it again on the next project, where planning has not already
been done.

## The one rule that matters

For a normal app, the framework's job is to prevent design drift. Here the design is
fixed and the real danger is different:

> A broken transaction boundary still passes every visible check. The demo runs, the
> UI animates, the counters move, and the project's central claim is silently false.

So the gate in this loop is not a code review. It is a set of assertions that fail
loudly when the guarantee is gone. Everything else in the loop exists to make sure
that gate runs.

---

## Setup, roughly thirty minutes

### 1. Project `CLAUDE.md`

Add to the repository root. Short on purpose; long context files get skimmed.

```md
# CORTEX

Shared, arbitrated memory for fleets of coding agents. CockroachDB + AWS.

## Non-negotiables
- Dedupe and claim happen in ONE transaction. If a refactor splits them, the
  project's core guarantee is void. There is a test for this; it must never be
  weakened or skipped.
- Agents hold read-only DB credentials. All writes go through the typed write API.
- Every write transaction is wrapped in the 40001 retry helper.
- No credential in a tracked file. No credential printed to stdout.
- The hosted demo never accepts a credential from the browser. No key field, no
  advanced panel, ever. BYO credentials is for the CLI only.
- The demo degrades, it never errors. Every limit resolves to a working page.
- Data-layer work is not done until tests pass against a REAL cluster. Mocks do not
  count for anything in the data layer.

## Working agreement
- Specs live in spec/. 03-MEMORY-MODEL.md and 05-INTERFACES.md are authoritative.
- Never load more than three spec files at once.
- Commit after every green unit: type(scope): description
- Stuck twice on the same problem → STOP, explain the blocker, propose options.
- Do not refactor outside the current unit's scope.
- Explain decisions in plain language. Say what it does, not just how.
- If the spec contradicts observed behaviour, STOP and report. Do not reconcile
  silently in code.
```

### 2. Four slash commands in `.claude/commands/`

> **Superseded 2026-08-10 — the commands below no longer exist under these names.**
> `.claude/commands/` holds `go.md`, `check.md` and `ship.md`. `/go` absorbs
> `lh-next` + `lh-work` + `lh-log`; `/check` absorbs `lh-gate` + `lh-fix`; `/ship` is
> the former `lh-ship`. The `lh-` prefix predates the project being called CORTEX.
>
> No content below was dropped — the four-item unit preamble, the transaction
> boundary statement, the `DECISIONS.md` `[OPEN]` step and the spec-error-goes-to-delta
> rule were folded into the two surviving commands, and `/check` gained rows for
> invariants 5 and 6 that no command here ever had. Two further changes: the four
> mechanical rows of the gate (typecheck, SQL containment, `.env` ignored,
> credentials) are now `scripts/gate-mechanical.sh`, a process that exits 2 rather
> than a prompt an agent can skip; and `docs/PROGRESS.md`, named below, was never
> created — `docs/UNITS.md` is the status of record.
>
> The prose is kept because it is where the reasoning lives. Read it for *why* each
> step exists, not for what to type.

**`lh-next.md`**

```md
Read spec/08-BUILD-PLAN.md and docs/PROGRESS.md.

Identify the next unit of work that is not yet complete. Output only:
1. The unit name and its "done when" condition, verbatim from the build plan.
2. Which spec files that unit requires (maximum three).
3. Anything that must be verified against the live system before starting.
4. The single biggest way this unit could silently break an invariant.

Do not start work. Do not write code. Stop after the output.
```

**`lh-work.md`**

```md
Argument: the unit name from /lh-next.

Before writing any code:
1. Restate in your own words why the deduplication check and the claim acquisition
   must share one transaction. If your restatement does not mention passing a check
   against a stale view and then acting on already-completed work, re-read
   spec/03-MEMORY-MODEL.md section 4.2 before continuing.
2. List the invariants from spec/03-MEMORY-MODEL.md section 8 that this unit could
   violate.
3. Write the tests for those invariants FIRST. They must fail before the
   implementation exists.

Then implement the smallest change that makes them pass.

Rules:
- Load only the spec files /lh-next named.
- Do not invent CockroachDB features, AWS limits, model ids, or pricing. Verify or
  say you did not.
- Do not write placeholder numbers in any document, ever. Write TBD.
- Do not assert a property in a comment or doc that the tests do not check.

Stop when the tests pass. Do not proceed to the next unit.
```

**`lh-gate.md`**

```md
Verification gate. Run in a fresh context. Refuse to pass on anything unverified.

1. Run the full invariant suite against a REAL cluster. Report the connection target.
   If it is a mock, an in-memory database, or a local single-node stand-in, STOP and
   report FAIL with the reason.
2. Search the codebase for the split-transaction anti-pattern: any path where the
   similarity check and the claim insert occur in different transactions, different
   connections, or different requests. Report every candidate with a file and line.
3. Confirm every write path is wrapped in the 40001 retry helper. List any that
   are not.
4. Confirm no agent-reachable path accepts arbitrary SQL, a table name, or any other
   structural parameter.
5. Grep tracked files for credentials, DSNs, and keys.
6. Search the demo surface for any input that accepts a credential: key fields, DSN
   fields, model overrides, advanced or developer panels, disabled or hidden inputs.
   Report every candidate with a file and line. Any hit is a FAIL, including one that
   is commented out or feature-flagged off.
7. Confirm the demo write path uses the cortex_demo principal and cannot write outside
   a demo session scope. Report the principal actually used at runtime, not the one
   the configuration names.
8. For each degradation rung in spec/04-ARCHITECTURE.md section 5, report whether it
   has been forced and what it rendered. A rung that has only been reasoned about is
   a FAIL.

Output a table: check, PASS or FAIL, evidence. Do not summarise as passing if any
row failed. Do not suggest fixes in this command; report only.
```

**`lh-log.md`**

```md
1. Append to docs/PROGRESS.md: unit name, done-when status, date.
2. Record in docs/verification-log.md anything verified against the live system in
   this session, with the actual output pasted, not summarised. **Correct existing
   entries in place; never append a contradiction.** When a check resolves, edit the
   line that said it was open. A log that accumulates contradictions is worse than
   no log, because it still looks authoritative.
3. Append to docs/DECISIONS.md any [OPEN] item closed this session, with the reason
   in one paragraph.
4. Append to docs/SPEC-DELTA.md anything in the specs that now looks wrong.
5. Commit.

If a section has nothing to add, write nothing for it. Do not pad.
```

### 3. The loop

```
/clear
/go                         → next unit from docs/UNITS.md, tests first, record, commit
/clear
/check                      → fresh context, adversarial, evidence required
```

`/clear` before `/go` and again before `/check` is not optional. The gate must not run
in the same context that wrote the code, or it will grade its own homework. This is the
one piece of GSD's design worth carrying over, and it is the part of this section that
survived the command rename unchanged.

## Cadence

- Run the full loop per unit in the day tables of `08-BUILD-PLAN.md`.
- Run `/check` at minimum at every end-of-day gate, and always before recording a
  benchmark number.
- Anything trivial — a typo, a README line, a config tweak — skip the loop entirely.
  Ceremony on trivial work is exactly the overhead you are trying to escape.

## 5. What this loop does worse than GSD, and the patches

Three honest gaps, in order of how much they cost you.

**Decomposition.** GSD's plan phase splits work into atomic plans and verifies each
fits in a fresh context. The blocks in `08-BUILD-PLAN.md` are three to six hours,
which is far too coarse. **Patch:** run the decomposition session in
`12-DAY-ZERO.md` §4 before starting, producing `docs/UNITS.md`. This is the single
most important addition; without it the loop degrades mid-unit exactly the way GSD
was built to prevent.

**Parallelism.** GSD runs independent plans in waves. This loop is sequential.
**Patch:** git worktrees, one Claude Code session each, two at a time, three at most.
Data layer merges first, and no branch merges without passing `/check` on its own.

**Failure diagnosis.** GSD generates a fix-plan when verification fails. **Patch:**
a fix step, which since 2026-08-10 lives inside `/check` rather than in a separate
command. The prompt it runs is unchanged:

```md
Argument: the failing rows from /check output.

1. For each failure, state the root cause in one sentence. Do not propose a fix yet.
2. Say whether the cause is a bug, a spec error, or an environment problem. If it is
   a spec error, write it to docs/SPEC-DELTA.md and stop.
3. Propose the smallest change that makes the failing check pass without weakening
   the check. If the only way to pass is to weaken or skip the assertion, STOP and
   say so plainly.
4. Implement it. Re-run only the failing checks.

Never modify a test to make it pass.
```

That last line is the whole point of the command. Under deadline pressure the
cheapest way to turn a gate green is to weaken it, and an agent will do that
helpfully unless told not to.

## Escape hatch

If the loop itself starts costing more than it saves, drop to: `/clear`, paste
`10-KICKOFF-PROMPT.md`, state the unit, work, run the invariant suite by hand.

The loop is scaffolding. The invariant suite is the product.
