# Units of work

The decomposition `spec/11-SHIP-LOOP.md` §5 calls for. Its blocks are three to six
hours, which is too coarse to survive one context — this file cuts them into units
that fit in one, each with the four things `/lh-next` has to output.

**An agent working here does not choose its own scope.** It takes the first unit
not marked done and works only that.

> `11-SHIP-LOOP.md` §5 points at `spec/12-DAY-ZERO.md` §4 for the decomposition
> session. **That file does not exist in this repo.** This decomposition was derived
> from `08-BUILD-PLAN.md` plus the invariants in `03-MEMORY-MODEL.md` §8 instead. If
> `12-DAY-ZERO.md` ever turns up, reconcile rather than assume this file is right.

Status: ✅ done · 🔶 partial · ⬜ not started

Day three is deliberately left coarse. Decomposing work that far out invents detail
that will not survive contact with days one and two; cut it into units at the start
of day three, not now.

---

## Day one — the mechanism

### U1 — Schema and migrations ✅
**Done when:** the schema applies to a clean cluster and re-applies without error.
**Specs:** `03` §2
**Evidence:** `sql/001_init.sql`, `IF NOT EXISTS` throughout, applied via `npm run sql`;
grants confirmed by `SHOW GRANTS` in the verification log.
**Silent break:** a column type that quietly differs from the spec — the `VECTOR(1024)`
width, or the `vector_cosine_ops` opclass V1 had to fix.

### U2 — `cortex init` ⬜
**Done when:** "`cortex init` produces a working cluster twice in a row." *(08 §3, 2–5h, verbatim)*
**Specs:** `05` §2, `03` §2
**Verify live first:** that `ccloud` can provision and that a second run is a no-op.
**Silent break:** printing a credential. `05` §2: no command may print one, and
`doctor` must fail loudly if a DSN appears in a tracked file.
**Note:** the migration is already idempotent (U1). This unit is the CLI wrapper
around it and nothing more. It is the only reason block 2–5h is not closed.

### U3 — Retry helper ✅
**Done when:** "forced `40001` retries and commits, covered by a test." *(08 §3, 5–9h, verbatim)*
**Evidence:** `src/db/retry.ts`, `test/retry.test.ts` — the conflict is produced by two
real interleaved clients, and a separate test asserts the interleaving genuinely
raises `40001`, so the recovery test cannot pass against a conflict-free harness.

### U4 — Typed layer: keys, propose, close, recall ✅
**Done when:** "all eight pass" — invariants 1–8 of `03` §8. *(08 §3, 9–14h, verbatim)*
**Evidence:** `src/memory/{keys,propose,close,recall}.ts`; 47 tests green against the
real cluster. Test 9 belongs to day three; it needs `cortex_demo` to exist.
**Two deviations from the spec text, both deliberate and commented in place:**
the claim insert uses `ON CONFLICT DO UPDATE` guarded on `expires_at` rather than
`DO NOTHING` (V4: the sweep lands 62–221s late); and `close` runs the ledger insert
first, so the unique index gates the whole operation.

### U5 — Embeddings via Bedrock, content-hash cache ⬜ ← **next**
**Done when:** "repeated intent does not re-embed." *(08 §3, 14–16h, verbatim)*
**Specs:** `05` §6, `04` §5, `03` §4.2
**Verify live first:** nothing — resolved 2026-08-09. `amazon.titan-embed-text-v2:0`
returns 1024 dimensions. Do **not** use a v5 reasoning model; they are not entitled
on this account.
**Silent break:** caching on the statement string rather than on a content hash of
what is actually sent. Two agents phrasing an intent identically must hit the cache;
one whose text differs by a byte must not silently reuse another's vector, because
dedupe is a distance test and a wrong vector produces a wrong arbitration decision.

### U6 — Two-terminal contention gate ⬜
**Done when:** "two processes in two terminals contend for one key, one wins, the
loser prints the winner's identity." *(08 §3, end-of-day-one gate, verbatim)*
**Specs:** `03` §4.2, `05` §2
**Silent break:** proving it with two transactions in one process. The tests already
do that. This gate is about two OS processes and two pools, which is a different
claim — it is the first thing that exercises the design as a fleet rather than as a
library.
**Blocks day two.** `08` §3: "If this does not work, day two does not start."

---

## Day two — the proof

### U7 — MCP server skeleton, stdio transport ⬜
**Done when:** a client lists the three write tools over stdio and gets the schemas
from `05` §3 verbatim.
**Specs:** `05` §3
**Silent break:** rewording a tool `description`. Those strings are prompt surface,
not documentation — they are what makes an unmodified third-party agent behave
correctly. Copy them.

### U8 — `cortex_propose` tool ⬜
**Done when:** a real coding agent attaches and successfully proposes. *(08 §4, 16–20h)*
**Specs:** `05` §3, `03` §4.2
**Silent break:** letting `blocked` or `deduped` surface as a tool error. They are
normal return values; an agent that sees an error will retry through a block, which
turns the fleet into a queue — the exact behaviour `03` §5 forbids.

### U9 — `cortex_close` and `cortex_heartbeat` tools ⬜
**Done when:** a granted intent can be closed exactly once through the tool surface,
and a long intent can extend its lease.
**Specs:** `05` §3, `03` §4.3
**Silent break:** `heartbeat` extending a lease the caller no longer holds. It must
verify the holder, or a dead agent's lease gets renewed by whoever asks.
**Not yet implemented at all:** `heartbeat` and `release` from `05` §1. Heartbeat is
cut-list item 6 — if time runs short, drop it and use a longer fixed lease.

### U10 — Agent Skill and the managed-MCP read path ⬜
**Done when:** "agent recalls without any bespoke client." *(08 §4, 20–23h, verbatim)*
**Specs:** `05` §4, `03` §4.1
**Verify live first:** that the managed MCP server accepts the recall SQL under
`cortex_reader`.
**Silent break:** shipping recall SQL in the skill that omits `WHERE repo_id`. Per V5
that fails open across tenants, and this is the one query that leaves the repo.

### U11 — Benchmark fixtures and task list ⬜
**Done when:** the corpus and the overlapping-task share exist and are committed.
**Specs:** `06`
**Silent break:** too little task overlap. `08` §7 names this: a benchmark showing no
difference means overlap is too low, not that the mechanism does not work.

### U12 — Five-agent runner and cassettes ⬜
**Done when:** "`cortex bench` runs both arms deterministically." *(08 §4, 23–29h, verbatim)*
**Specs:** `06`
**Silent break:** non-determinism leaking in through model calls or wall-clock time,
so two runs of the same arm disagree and the published number is unreproducible.

### U13 — Metrics, duplicate judge, results writer ⬜
**Done when:** "`bench/results/` populated and committed." *(08 §4, 29–32h, verbatim)*
**Specs:** `06`
**Silent break:** a placeholder number reaching a results file. Write TBD.
**End-of-day-two gate:** the summary table shows a real difference between the arms.
From that moment the project is submittable even if everything else fails.

---

## Day three — the surface (decompose at the start of day three)

Coarse on purpose. In `08` §5 order: infra and deploy (32–38h) · demo SPA (38–44h) ·
guardrails and all four degradation rungs (44–47h) · README and disclosure (47–52h) ·
video (52–58h) · Devpost (58–60h).

Three things carried forward that must not be forgotten:

- **§8 test 9** — `cortex_demo` cannot write outside a live session scope. Blocked on
  the `04` §3 `[OPEN]`, and V5 narrowed it: confinement cannot rest on the index
  prefix, so it has to come from the principal's grants.
- **The video is recorded in LIVE mode** at 52–58h, and LIVE reasoning now runs on a
  4-5 model. Confirm that path end to end before the recording session, not during it.
- **`08` §7 says deploy a hello-world through the full pipeline on day one evening**,
  not on day three. Deployment eating day three is the medium-likelihood, high-impact
  risk in the register.
