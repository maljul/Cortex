Verification gate. Report only; do not fix. Refuse to pass anything
unverified.

1. TRANSACTION INTEGRITY — the check that matters most.
   The dedupe SELECT against intents and the INSERT into claims must run on
   one pg client inside one transaction. Report every candidate for a split:
   - pool.query used anywhere inside the propose path
   - a client released or reacquired between the two statements
   - dedupe and claim exposed as separately callable exported functions
   - two withRetry calls in one propose invocation
   Give file and line for each. If none, say so explicitly.

2. RETRY COVERAGE
   Every write transaction wrapped in withRetry. List any that are not.

3. SQL CONTAINMENT
   grep -rn "SELECT\|INSERT\|UPDATE\|DELETE" src/ --include=*.ts | grep -v "src/memory/\|src/db/"
   Any hit is a violation.

4. PRIVILEGE PLANE
   No agent-reachable path accepts arbitrary SQL, a table name, or any other
   structural parameter. Confirm the reader path issues SELECT only.

5. CREDENTIALS
   git check-ignore .env
   git log -p --all | grep -iE "postgresql://|AKIA|sk-ant" | head
   Both must come back clean.

6. INVARIANT SUITE
   Run it. Report the connection target. If it is a mock, in-memory, or a
   local single-node stand-in, this row is FAIL regardless of test results.

Output a table: check, PASS or FAIL, evidence. If any row failed, the gate
did not pass — do not summarise it as passing.
