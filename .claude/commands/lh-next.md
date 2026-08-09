Read docs/UNITS.md and the "Current state" block at the top of CLAUDE.md.

Identify the next incomplete unit. Output only:

1. Unit name and its done-when condition, verbatim from UNITS.md.
2. Spec files it requires (max three).
3. Anything needing verification against the live cluster or Bedrock first.
4. The single biggest way this unit could silently break an invariant from
   spec/03-MEMORY-MODEL.md section 8.

If the unit touches src/memory/, state which of the four tiers it writes to
(claims, intents, findings, action_ledger) and whether that write shares a
transaction with any other.

Do not start work. Do not write code.
