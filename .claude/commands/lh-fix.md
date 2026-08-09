Argument: the failing rows from /lh-gate.

1. Root cause of each failure, one sentence. No fixes yet.
2. Classify: bug, spec error, or environment. If spec error, write it to
   docs/SPEC-DELTA.md and stop.
3. Propose the smallest change that makes the check pass WITHOUT weakening
   it. If the only way to pass is to weaken, skip, or narrow the assertion,
   stop and say so plainly.
4. Implement. Re-run only the failing checks.

NEVER modify a test to make it pass. Under deadline pressure the cheapest
way to turn a gate green is to lower the bar; that is the one thing this
command exists to prevent.
