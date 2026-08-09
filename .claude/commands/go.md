Work the next unit end to end. Read docs/UNITS.md (the status of record)
and the state block in CLAUDE.md.

STEP 0 — KNOW WHAT'S NEXT, OR STOP.
Pick the first unit not marked done. If any of these is true, STOP and ask
me — do not guess, do not pick a nearby unit, do not invent scope:
  - two sources disagree about what's next
  - the done-when condition is not testable as written
  - the unit depends on something not built
  - the spec is silent or contradictory on something the unit needs
When you stop, say in one paragraph what is ambiguous and what you'd need
to proceed. A wrong unit costs more than a question.

STEP 1 — RESEARCH BEFORE GUESSING.
If the unit touches an API, SQL syntax, or SDK shape you are not certain
of — CockroachDB vector syntax, Bedrock request shapes, the MCP SDK —
look it up via Context7 or the live cluster first. Do not write from
recall. You have already been wrong once about vector index syntax.
State plainly what you looked up and what you assumed.

STEP 2 — TESTS FIRST.
Name the invariants from spec/03-MEMORY-MODEL.md §8 this unit could break.
Write those tests before the implementation; they must fail first. Then
mutate your implementation once to confirm at least one assertion is
load-bearing.

STEP 3 — IMPLEMENT.
Smallest change that passes. Repo rules:
  - SQL only in src/memory/ and src/db/
  - every write through withRetry
  - agent-facing reads assume cortex_reader, SELECT only
  - tests run against the real cluster via CORTEX_DSN; a passing mock
    proves nothing in the data layer
  - do not extend src/extract/graph.ts
  - never a placeholder number in a doc; write TBD
  - never assert in a comment or doc what no test checks

STEP 4 — RECORD, THEN CONTINUE.
  - mark the unit done in docs/UNITS.md
  - update the state block in CLAUDE.md, correcting stale lines IN PLACE
  - paste real output into docs/verification-log.md for anything verified
    live; append spec problems to docs/SPEC-DELTA.md
  - note anything worth screen-recording for the video
  - commit
Then go back to STEP 0 and work the next unit. Keep going until you hit an
ambiguity, a failing test you cannot fix without weakening it, or three
completed units — then stop and summarise.
