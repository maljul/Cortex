# Decisions

Decisions that closed something, with the reasoning that closed it. One entry per
decision, newest last. If a decision is later reversed, correct the entry in place
and say why — do not append a contradiction.

---

## 2026-08-09 — Heartbeat and lease extension will not be implemented

`08` §6 ranks heartbeat and lease extension as cut-list item 6, and the decision has
been taken now rather than under time pressure on day three. U9 is `cortex_close`
only. Long-running work gets a longer fixed lease instead of a renewable one.

The reasoning: a renewable lease has to verify that the caller still holds the intent
before extending it, or a dead agent's lease gets renewed by whoever asks — which is
worse than no heartbeat at all, because it converts an expiry that would have freed
the key into one that never fires. That check is not hard, but it is a correctness
surface on the critical path, and the alternative costs one constant. A fixed lease
long enough for the benchmark's slowest task has the same failure mode as a short one
(a dead agent's keys are unavailable until expiry) and simply sets the constant higher.

What was kept: the tool is still advertised and its schema is now settled in `05` §3,
served by U7. So this stays a scheduling decision — if day three turns out to have the
hour, implementing it changes no other surface. Calling it today returns
not-implemented, which is honest, rather than a silent no-op that an agent would read
as a successful extension.

Cost saved: roughly an hour on the day-two critical path.

## 2026-08-09 — Node for everything; `05` §2's runtime `[OPEN]` is answered in practice

`05` §2 leaves Node versus Python open for the CLI, with a mild preference for Node
because `npx` gives zero-install onboarding. The repository has in fact been Node and
TypeScript throughout — cluster access, embeddings, arbitration and benchmark
scaffolding — and B1 committed to one module system across all of it with a clean
`npx tsc --noEmit`. A split runtime would now mean adding a toolchain, not choosing
between two.

**The `[OPEN]` marker in `05` §2 has not been edited.** Closing it is Julian's call,
not a side effect of a build fix; it is recorded in `docs/SPEC-DELTA.md` as stale so
it is not re-litigated by whoever reads §2 next.
