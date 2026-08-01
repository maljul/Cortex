# Verification log

What was checked against a live cluster, when, and what it actually returned.

Rules for this file, from `spec/10-KICKOFF-PROMPT.md`:

- Paste **actual output**, not a summary of it. "Worked" is not a result.
- If a check fails, record the exact error text and which fallback you took.
- Never write a placeholder number. Write `TBD`.

Cluster: `TBD` (tier, region, version)
Date started: 2026-08-01

---

## V1 — Vector index with a prefix column

Spec: `spec/04-ARCHITECTURE.md` §8 · Fallback: brute-force ordering, no index

**Result:** TBD

```
paste the SELECT output and the EXPLAIN plan here
```

Did the EXPLAIN plan mention the vector index rather than a full scan? TBD

---

## V4 — Row-level TTL

Spec: `spec/03-MEMORY-MODEL.md` §1 · Fallback: none specified — working memory
reclamation depends on this

**Result:** TBD

```
paste SHOW CREATE TABLE _v4 output, then the count after waiting two minutes
```

---

## V2 — Changefeed with a webhook sink

Spec: `spec/04-ARCHITECTURE.md` §8 · Fallback: EventBridge Scheduler polling a
watermark every two seconds · **Time box: 20 minutes, then take the fallback**

**Result:** TBD

```
paste the CREATE CHANGEFEED result, or the exact error, and whether a payload arrived
```

---

## V3 — Historical query window

Spec: `spec/03-MEMORY-MODEL.md` §6 · Fallback: drop the time-travel panel

**Result:** TBD

Which offset first failed, and the exact GC-threshold error: TBD

That boundary is the demo's rewind limit.

---

## Bedrock model access

Per-account and per-region, and a classic day-three surprise.

- Region: TBD
- Titan Text Embeddings V2 access granted: TBD
- Reasoning model access granted: TBD

---

## Service accounts

Three principals, per `spec/04-ARCHITECTURE.md` §3.

- `cortex_reader` created, `SELECT` only, verified with `SHOW GRANTS`: TBD
- `cortex_writer` created, no `SELECT`-only overlap: TBD
- `cortex_demo` created, confined to demo session scopes: TBD
- Confinement mechanism chosen (separate cluster vs scoped `repo_id`s), and why: TBD
