# 07 — Demo and Submission

---

## 1. What the demo must accomplish

A judge arrives with no context, no account and no patience. In under ninety seconds
they must reach: *the database is doing something here that a vector store plus a
lock service could not do.*

Design consequences:

- No signup, no key, no configuration. One click to a running scenario.
- Nothing loads slowly. Pre-warm and pre-seed everything.
- Every number on screen is real and comes from the database.
- One button reveals the literal SQL. Sceptics are the audience worth designing for.

## 2. Layout

Three panels, fixed, no navigation.

**Left — the fleet.** Five agent cards. Each shows current intent, status, and a
badge when it is deduped or blocked. Movement here is the narrative.

**Centre — the memory.** Live rows arriving from the changefeed stream, grouped by
tier: working, episodic, semantic, procedural. Each row shows its real primary key.
A "show SQL" toggle replaces the pretty view with the executed statements.

**Right — the meter.** Live counters: duplicate work avoided, tokens saved,
serialization retries handled, claim p50 in milliseconds. Plus the mode switch:
`LEASEHOLD` versus `NAIVE`.

The naive toggle is the demo's spine. Same scenario, same cassettes, visibly
different outcome. Contrast persuades; description does not.

## 3. The four beats

Ordered to satisfy the memory-first narrative from `01-PROJECT-BRIEF.md` §5.

| Beat | What the judge sees | What it proves |
| --- | --- | --- |
| **1. Recall** | agent-1 starts and immediately cites a finding from "a session 14 days ago", with a note that a prior attempt was reverted | long-term memory across sessions, not chat history |
| **2. Dedupe** | agent-4 declares an intent worded differently from agent-2's in-flight intent; it is deduped before spending a token; the counter increments | semantic memory used as a decision, not a lookup |
| **3. Claim** | agent-3 and agent-5 reach for the same file in the same instant; one wins, the loser receives the winner's identity and re-plans | arbitration co-located with memory |
| **4. Consolidate** | a closed intent becomes a durable finding a moment later, arriving via the change stream | memory that improves rather than accumulates |

Then the toggle: NAIVE, same scenario, and the judge watches duplicate work climb and
a write disappear.

## 4. Modes and the honesty rule

| Mode | Model calls | Database | Default |
| --- | --- | --- | --- |
| `REPLAY` | none, cassettes from S3 | fully live | yes |
| `LIVE` | Bedrock, capped | fully live | on click, while quota remains |

An always-visible line in REPLAY: `replay mode: agent reasoning is cached, all
database behaviour is live`.

**The video is recorded in LIVE mode.** The rules require the project to function as
depicted. Never narrate replay footage as live inference.

Guardrails are specified in `04-ARCHITECTURE.md` §5. When the LIVE quota is exhausted
the UI must degrade to REPLAY with a plain explanation, never with an error, and never
by asking the visitor for a key. Asking a judge for credentials would sit badly
against the requirement that the project be available without restriction.

## 5. Video script — 2:50

Judges are not required to watch past three minutes, and many will decide in the first
twenty seconds. Front-load the proof.

| Time | Screen | Voice or caption |
| --- | --- | --- |
| 0:00–0:12 | terminal, five agents launching on one repo | "Five coding agents. One repository. Watch what happens to their work." |
| 0:12–0:30 | NAIVE mode running, duplicate counter climbing, a write vanishing | "This is the normal stack: a shared task file and a vector store. Seventy-eight percent of this work is about to be thrown away, and one write is about to be lost silently." |
| 0:30–0:45 | benchmark table, full screen | "Same agents, same tasks, same cached reasoning. The only difference is where the memory lives." |
| 0:45–1:15 | LEASEHOLD mode, beat 1 then beat 2 | "Agent one recalls that this refactor was reverted two weeks ago. Agent four discovers that its task is already in flight and stands down before spending a token." |
| 1:15–1:40 | beat 3, split screen with rows arriving | "Two agents reach for the same file in the same instant. Deduplication and the right to act commit in one SERIALIZABLE transaction, on one snapshot. A separate vector store and lock service cannot do that, because they have no common commit point." |
| 1:40–1:55 | the recall SQL on screen | "One query joining semantic similarity to structural outcome history. This is the query a vector database cannot run." |
| 1:55–2:15 | beat 4, consolidation arriving over the change stream | "A closed task becomes durable knowledge, off the critical path, driven by CockroachDB's change feed." |
| 2:15–2:30 | kill an agent, claims reclaimed, fleet continues | "Kill an agent and its claims expire on their own. Row-level TTL, not a supervisor." |
| 2:30–2:50 | architecture diagram | "Managed MCP server as the agent's only read path. Agents hold no write credentials. Everything on AWS, everything in one cluster." |

Production notes: no third-party agent logos in frame, use the scripted agent mode for
capture. Silent or self-produced audio. English captions. Terminal at a font size
legible at 720p, because that is how it will be watched.

## 6. Devpost description — draft structure

The description is a scored artifact in its own right. Order matters.

1. **One-sentence thesis.** The durable-execution contrast line from `00-INDEX.md`.
2. **The benchmark table.** Above the fold, before any prose about architecture.
3. **What it is.** Three sentences. Shared arbitrated memory for agent fleets, not a
   framework, not an orchestrator.
4. **The four memory tiers**, with the database primitive that implements each.
5. **The one query a vector database cannot run.** Paste it.
6. **Architecture diagram.**
7. **CockroachDB tools and what the agent did with them.** Paste section C of
   `02-COMPLIANCE-MATRIX.md` verbatim.
8. **AWS services and how.** Paste section D.
9. **Production readiness.** Privilege planes, failure modes table, guardrails.
10. **Prior art and how this differs.** The table from the brief. Naming competitors
    is a strength.
11. **Limitations.** Written by you, honestly.
12. **Feedback on the CockroachDB AI tools.** Detailed and specific. It is an optional
    field that almost nobody fills in properly, and it costs you fifteen minutes.

## 7. Repository README — first screen

The first screen decides both judging and stars.

```
LEASEHOLD
shared, arbitrated memory for fleets of coding agents

[ GIF: two agents reaching for one file, one standing down, counter incrementing ]

| metric              | naive | leasehold |
| duplicate_work_rate |  0.xx |      0.00 |
| lost_writes         |     n |         0 |

npx leasehold init

Durable execution gives exactly-once within one workflow. It does not give mutual
exclusion between agents that do not know each other exists.
```

Nothing else above the fold. No badges, no table of contents, no architecture
paragraph. GIF, numbers, install line, thesis.
