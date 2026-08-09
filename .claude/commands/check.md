Adversarial gate. Fresh context. Report only, never fix.

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

2. npx tsc --noEmit — must exit clean.

3. SQL containment:
   grep -rn "SELECT\|INSERT\|UPDATE\|DELETE" src/ --include=*.ts | grep -v "src/memory/\|src/db/"

4. No agent-reachable path accepts SQL, a table name, or any undeclared
   argument. No credential field on any surface, under any name.

5. git check-ignore .env
   git log -p --all | grep -iE "postgresql://|AKIA|sk-ant" | head

6. Invariant suite against the REAL cluster. Report the connection target.
   A mock or local stand-in is FAIL regardless of results.

Table: check, PASS or FAIL, evidence. If any row failed, the gate did not
pass. Do not summarise it as passing.

For each FAIL, propose the smallest fix that does NOT weaken the check. If
the only way to pass is to weaken, skip, or narrow an assertion, say so
plainly. Never modify a test to make it pass.
