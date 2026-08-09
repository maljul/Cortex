Adversarial gate. Report only, never fix.

RUN THIS BLIND. Fresh context, and a session that has NOT written code this
cycle. A gate run by the agent that just wrote the code is checking its own
memory of what it meant, not the repo — it knows where it was careful and
looks there. If you wrote code this session, say so before starting and
treat every clean row as weaker evidence than it looks.

Finding nothing right after a unit shipped code is itself a result worth
stating plainly, not a pass to hurry past.

1. TRANSACTION INTEGRITY — the one that matters.
   The dedupe SELECT on intents and the INSERT into claims must run on one
   pg client in one transaction. Flag every candidate split:
     - pool.query inside the propose path
     - a client released or reacquired between the two statements
     - dedupe and claim separately exported and callable
     - two withRetry calls in one propose
     - an MCP handler opening its own client instead of calling the
       existing arbitration function in src/memory/
   File and line for each. If none, say so explicitly.

2. RETRY COVERAGE — invariant 6.
   Every write transaction goes through withRetry from src/db/retry.ts.
   List any that do not.

3. TENANT ISOLATION — invariant 5.
   Every read carries WHERE repo_id. Sweep the reads in src/memory/ and
   list any without the filter, including reads that exist only to build an
   error message. The vector index prefix is NOT the boundary — V5 measured
   it falling back to a full scan and returning another repo's rows, so a
   forgotten filter fails open. A refusal that distinguishes "belongs to
   another repo" from "no such row" is an existence oracle and counts as a
   violation even though it refuses.

4. MECHANICAL ROWS — run `./scripts/gate-mechanical.sh --report`.
   Typecheck, SQL containment, .env ignored, credentials in history. Paste
   its table. This is the same script the commit hook runs, so the gate and
   the block cannot disagree about what passing means. Do not re-derive
   these by hand and do not describe them as passing without the output.

5. PRIVILEGE PLANE
   No agent-reachable path accepts SQL, a table name, or any undeclared
   argument. The reader path issues SELECT only. No credential field on any
   surface, under any name, including commented out or feature-flagged off.

6. INVARIANT SUITE — against the REAL cluster.
   Run it. Report the connection target. A mock, in-memory, or local
   single-node stand-in is FAIL regardless of test results. Also report
   which items of spec/03-MEMORY-MODEL.md section 8 have no test at all: a
   green suite over partial coverage is not a passing row, and "N/N passed"
   must never be offered as though it were section 8.

Table: check, PASS or FAIL, evidence. If any row failed, the gate did not
pass. Do not summarise it as passing.

For each FAIL, propose the smallest fix that does NOT weaken the check. If
the only way to pass is to weaken, skip, or narrow an assertion, say so
plainly. Never modify a test to make it pass.

NOTHING LEAVES THIS GATE IN SCROLLBACK.
Report-only earns its keep during the gate — an auditor that fixes what it
finds has an incentive to under-report. It stops earning it once the report
exists. So after the table, in the same session:
  - small and verifiable: fix it. Test first, watch it fail, then fix, then
    re-run the row
  - blocked or out of scope: write it down — docs/verification-log.md with
    real output pasted, or the relevant unit in docs/UNITS.md
  - a spec error: docs/SPEC-DELTA.md, recorded and not reconciled in code
Then say which findings went where. Findings outside the numbered rows are
the ones that evaporate, and they are also the ones the rows were not
looking for.
