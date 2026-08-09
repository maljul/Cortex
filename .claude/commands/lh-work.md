Argument: the unit name from /lh-next.

BEFORE ANY CODE
1. Name the invariants from spec/03-MEMORY-MODEL.md section 8 this unit
   could violate.
2. Write those tests first. They must fail before the implementation exists.
3. If the unit touches the propose path, state where the transaction begins
   and ends, and confirm the dedupe SELECT and the claims INSERT use the
   same pg client.

THEN implement the smallest change that makes them pass.

REPO RULES
- All SQL lives in src/memory/ or src/db/. No SQL anywhere else, ever.
- Every write goes through withRetry from src/db/retry.ts.
- Reads for agents assume the cortex_reader account: SELECT only. If your
  code needs a verb the reader lacks, it belongs on the write path instead.
- ESM: relative imports carry the .js extension.
- Tests run against the real cluster via CORTEX_DSN. A passing mock proves
  nothing in the data layer.

DO NOT
- Extend src/extract/graph.ts. It belongs to the consolidation unit and is
  already ahead of schedule.
- Invent CockroachDB syntax, AWS limits, model ids, or pricing. Verify, or
  say plainly that you did not.
- Write placeholder numbers in any document. Write TBD.
- Assert a property in a comment or doc that no test checks.

Stop when the tests pass. Do not continue to the next unit.
