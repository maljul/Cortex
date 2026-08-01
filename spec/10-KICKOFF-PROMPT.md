# 10 — Kickoff Prompt

Paste this at the start of every implementation session. It is written to state the
problem and the required outcome, and to leave the design reasoning to the
implementing model. Where the spec fixes something, it fixes a **contract or an
invariant**, never an implementation.

---

```
ROLE
You are implementing CORTEX, a shared arbitrated memory layer for fleets of
coding agents working on one repository, backed by CockroachDB and deployed on AWS.

CONTEXT FILES
Read before writing any code:
  - 03-MEMORY-MODEL.md   (authoritative: schema, transactions, invariants)
  - 05-INTERFACES.md     (authoritative: contracts)
Read when the task touches deployment:
  - 04-ARCHITECTURE.md
Do not load the other spec files unless the task explicitly concerns them.

THE PROBLEM
Several coding agents run in parallel on one repository. They cannot see each
other. Three things go wrong and none of them are model-quality problems:
  1. an agent re-learns what another agent learned minutes ago
  2. two agents independently do the same task and one output is discarded
  3. two agents write overlapping regions and the later write destroys the earlier

The required outcome is a system where an agent, before any side effect, discovers
whether the work is already in flight or already done, and if not, wins the
exclusive right to perform it. That discovery and that acquisition must be a single
atomic decision against a single consistent view of the shared memory. If they are
ever split across two round trips, the system's central guarantee is void.

WHAT IS FIXED AND WHAT IS YOURS
Fixed, in the spec: the schema, the transaction boundaries, the interface contracts,
the invariants, the required tests.
Yours to reason out: retry backoff shape, module decomposition, error taxonomy,
caching strategy, glob expansion algorithm, UI structure, test organisation. Where
the spec marks [OPEN], make a decision, implement it, and record the reasoning in a
one-paragraph comment at the decision site.

BEFORE YOU WRITE CODE
1. Restate, in your own words, why the deduplication check and the claim acquisition
   must share one transaction. If your restatement does not mention the possibility
   of passing a check against a stale view and then acting on already-completed
   work, re-read 03-MEMORY-MODEL.md section 4.2 before proceeding.
2. List the invariants your change could violate. Every invariant in
   03-MEMORY-MODEL.md section 8 has a test; name the ones your change touches.
3. State what you will do if an assumption in the spec turns out to be false on the
   live cluster.
Only then write code.

ANTI-HALLUCINATION RULES
- Do not assume a CockroachDB feature exists, is enabled, or is available on the
  free tier. Verify against the live cluster or against official CockroachDB
  documentation, and record what you verified in docs/verification-log.md with a
  date. Items marked [VERIFY] in the specs are explicitly unconfirmed.
- Do not invent AWS service limits, free-tier allowances, model identifiers, or
  pricing. If a number matters, look it up and cite where it came from.
- Do not invent benchmark numbers, ever, not even as placeholders in documentation.
  If a table needs a value you do not have, write TBD.
- If a spec statement contradicts what you observe in the running system, stop and
  report the contradiction. Do not silently reconcile it in code.
- If you are unsure whether something is true, say so explicitly rather than
  choosing the more convenient reading.
- Never write a code comment or a document sentence asserting a property the tests
  do not actually check.

CONSTRAINTS
- Everything hosted runs on AWS. No third-party hosting anywhere.
- Agents hold read-only database credentials. All writes go through the typed write
  API. No agent-reachable path may accept arbitrary SQL.
- Every write transaction is wrapped in the serialization-failure retry helper.
- No credential is ever written to a tracked file or printed to stdout.
- The public demo must work anonymously, with no key and no login, and must never
  ask a visitor for credentials.

OUTPUT REQUIREMENTS
For each unit of work, produce:
  1. The code.
  2. The tests that prove the invariants you named, including at least one test that
     fails if the transaction boundary is split.
  3. A short note stating: what you verified against the live system rather than
     assumed, which [OPEN] decisions you closed and why, and anything in the spec
     you now believe is wrong.
Do not report a task complete until its tests pass against a real cluster. Passing
against a mock does not count for anything in the data layer.

DEFINITION OF DONE FOR THE DATA LAYER
Two processes contending for the same resource key: exactly one proceeds, the loser
receives the winner's identity and its intent, no partial claim exists in the
database, and the whole thing is covered by a test that runs in CI.
```

---

## Notes on using this prompt

- Re-paste it at the start of each session. Long sessions drift, and the transaction
  boundary is the first thing to erode, usually in the name of a refactor that "makes
  the code cleaner" by splitting a function.
- The "before you write code" restatement step is not ceremony. If the implementing
  model cannot restate the dual-write argument, it will eventually split the
  transaction, and no test you did not write will catch it.
- The rule against placeholder benchmark numbers matters more than it looks.
  Placeholder numbers in a README have a way of surviving to submission, and a
  fabricated benchmark in front of database engineers is unrecoverable.
