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

## 2026-08-09 — `repo` on the tool surface is a slug, resolved to `repo_id` on first sight

`05` §6 hands an agent `CORTEX_REPO`, a slug; `03` §2 keys every table on a
`repo_id` UUID. Everything before U8 was handed that UUID by its caller, so the tool
surface is the first place the tenant boundary has to be *derived*. `src/memory/repos.ts`
resolves the slug through the `repos` table — read, then insert on conflict do
nothing, then re-read outside that transaction because its snapshot predates a
concurrent commit and a second read inside it can legitimately see nothing.

Two things were decided rather than defaulted. The slug is **case folded**, unlike
the path body of a resource key, because the costs are asymmetric: two spellings of
one file are two files on a case-sensitive checkout, but two spellings of one remote
are one repository, and splitting a tenant in two leaves both halves granted with no
error anywhere. And the insert deliberately does **not** join the arbitration
transaction: it is not part of the all-or-nothing claim set, and putting the one row
every agent in a fleet touches inside the SERIALIZABLE claim transaction would
manufacture 40001s on the critical path of every proposal. It goes through
`withRetry` on its own, which invariant 6 requires and which six concurrent
first-calls in the test suite exercise.

## 2026-08-09 — `glob:` keys are never silently narrowed *(extended 2026-08-10: they are now expanded when a root is configured)*

**Superseded in part, and corrected here rather than contradicted below.** The decision
that held was the second half — never claim the bare `glob:` row. What changed on
2026-08-10 is that the server no longer *only* refuses: `05` §6 gained
`CORTEX_REPO_ROOT`, and when it is set `cortex_propose` expands a glob into one claim
per matched file plus the glob row, which is the overlap `03` §3 asks for. With it
unset the refusal below still stands, for exactly the reason given below.

The original entry:

`03` §3 makes a glob's overlap structural: a glob is claimed as one row per matched
file *plus* a row for the glob itself, which is what makes a later `file:` claim on a
matched path collide. That expansion needs a checkout to match against, and `05` §6
configures the MCP server with no repository root — it is launched by an agent from
wherever that agent happens to be.

The tempting shortcut is to claim the bare `glob:` row and move on. That is the worst
available option: it looks like it worked, and it leaves every `file:` claim the glob
should have covered unblocked. A double grant with no error is exactly the failure
this project exists to prevent. So `cortex_propose` refuses a glob and says why, which
matches §3's own stated default of refusing rather than claiming at directory
granularity. `expandKeys` still supports globs through its injected resolver, so a CLI
that does know the repository root loses nothing.

**This is a narrowing of what `05` §3's published schema advertises** — its
`resource_keys` description names `glob:<pattern>` — and it is recorded in
`docs/SPEC-DELTA.md` rather than fixed by editing the description, because the
description is prompt surface pinned verbatim against the spec by a test.

## 2026-08-09 — `cortex_close` requires its repository; only `cortex_propose` registers one

`src/memory/repos.ts` exposes two resolvers rather than one. `resolveRepoId`
registers a repository on first sight and belongs to propose, which genuinely is the
first thing a new repository does. `requireRepoId` refuses an unknown slug and is
what close uses.

The reasoning is about which error a caller gets. A close is never legitimately the
first call a repository makes — there is nothing to close until something has been
proposed — so an unrecognised slug at that surface is a typo, near-certainly in
`CORTEX_REPO`. Registering it would succeed, mint an empty tenant, and then answer
"no intent <uuid> in this repo", which is true, unhelpful, and points the caller at
their intent id instead of at the one character they got wrong. It would also leave a
junk row behind on every occurrence. Refusing says "unknown repo" and names the
actual fault.

The same rule will apply to `release`, and would have applied to `heartbeat` had it
not been cut.
