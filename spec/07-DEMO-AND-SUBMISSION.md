# 07 — Demo and Submission

---

## 1. What the demo must accomplish

A judge arrives with no context, no account and no patience. In under ninety seconds
they must reach: *the database is doing something here that a vector store plus a
lock service could not do.*

Design consequences:

- No signup, no account, no key, no cluster, no card, no configuration. One click to a
  running scenario. This is a rules requirement, not a courtesy: see `02` B4.
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
`CORTEX` versus `NAIVE`.

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

Guardrails and the full degradation ladder are specified in `04-ARCHITECTURE.md` §5.
The LIVE quota is only the first of four limits this demo can reach; the others are
embeddings, the per-session row cap, and the backend itself. Each degrades to a
working page with a plain explanation.

**Two absolute rules, both downstream of rule B4.**

The demo MUST NOT ever present an error page in place of a scenario. A judge who
arrives at a capped demo and sees a stack trace has been told the project does not
work, and no README sentence recovers that.

The demo MUST NOT ever accept a credential from the browser. No key field, no
advanced settings panel, no developer mode, no "use your own model" escape hatch —
not disabled, not hidden, not present. The reasoning is not that a judge would refuse
to supply one, though most would. It is that the field itself is the hazard: once it
exists on a public page, somebody eventually pastes a live production key into it,
and you own that. Bring-your-own-credentials is right for the CLI, where the user
provisions their own cluster for their own repository. It is never right here.

Rung 4 carries the same honesty obligation as REPLAY. If the walkthrough is
pre-recorded because the backend is unreachable, the banner says so. A static
fallback that silently depicts a live system would breach rule A7 far more seriously
than replayed reasoning does.

## 5. Video script — 2:50

Judges are not required to watch past three minutes, and many will decide in the first
twenty seconds. Front-load the proof.

| Time | Screen | Voice or caption |
| --- | --- | --- |
| 0:00–0:12 | terminal, five agents launching on one repo | "Five coding agents. One repository. Watch what happens to their work." |
| 0:12–0:30 | NAIVE mode running, duplicate counter climbing, a write vanishing | "This is the normal stack: a shared task file and a vector store. Seventy-eight percent of this work is about to be thrown away, and one write is about to be lost silently." |
| 0:30–0:45 | benchmark table, full screen | "Same agents, same tasks, same cached reasoning. The only difference is where the memory lives." |
| 0:45–1:15 | CORTEX mode, beat 1 then beat 2 | "Agent one recalls that this refactor was reverted two weeks ago. Agent four discovers that its task is already in flight and stands down before spending a token." |
| 1:15–1:40 | beat 3, split screen with rows arriving | "Two agents reach for the same file in the same instant. Deduplication and the right to act commit in one SERIALIZABLE transaction, on one snapshot. A separate vector store and lock service cannot do that, because they have no common commit point." |
| 1:40–1:55 | the recall SQL on screen | "One query joining semantic similarity to structural outcome history. This is the query a vector database cannot run." |
| 1:55–2:15 | beat 4, consolidation arriving over the change stream | "A closed task becomes durable knowledge, off the critical path, driven by CockroachDB's change feed." |
| 2:15–2:30 | kill an agent, claims reclaimed, fleet continues | "Kill an agent and its claims expire on their own. Row-level TTL, not a supervisor." |
| 2:30–2:50 | architecture diagram | "Agents read as a SELECT-only SQL role and hold no write credentials — nine attempted writes, nine refusals, in the test suite. Everything on AWS, everything in one cluster." |

Production notes: no third-party agent logos in frame, use the scripted agent mode for
capture. Silent or self-produced audio. English captions. Terminal at a font size
legible at 720p, because that is how it will be watched.

## 6. Devpost description — draft structure

The description is a scored artifact in its own right. Order matters.

1. **One-sentence thesis.** The durable-execution contrast line from `00-INDEX.md`.
2. **The benchmark table.** Above the fold, before any prose about architecture.
3. **How to try it, in one line.** The demo URL, followed by: no account, no API key,
   no cluster, no card, nothing to install. Judges scan for setup friction before they
   read anything else, and a submission that looks like it needs provisioning gets
   skipped for one that does not. Say in the same breath that the CLI is where you
   bring your own cluster, so nobody mistakes the two.
4. **What it is.** Three sentences. Shared arbitrated memory for agent fleets, not a
   framework, not an orchestrator.
5. **The four memory tiers**, with the database primitive that implements each.
6. **The one query a vector database cannot run.** Paste it.
7. **Architecture diagram.**
8. **CockroachDB tools and what the agent did with them.** Paste section C of
   `02-COMPLIANCE-MATRIX.md` verbatim.
9. **AWS services and how.** Paste section D.
10. **Production readiness.** Privilege planes including the demo's separate confined
    principal, failure modes table, guardrails, degradation ladder.
11. **Prior art and how this differs.** The table from the brief. Naming competitors
    is a strength.
12. **Limitations.** Written by you, honestly.
13. **Feedback on the CockroachDB AI tools.** Detailed and specific. It is an optional
    field that almost nobody fills in properly, and it costs you fifteen minutes.

## 7. Repository README — first screen

The first screen decides both judging and stars.

```
CORTEX
shared, arbitrated memory for fleets of coding agents

[ GIF: two agents reaching for one file, one standing down, counter incrementing ]

| metric              | naive | cortex |
| duplicate_work_rate |  0.xx |      0.00 |
| lost_writes         |     n |         0 |

Try it:   <demo url>      no account, no key, no cluster, nothing to install
Run it:   npx cortex init  provisions your own free cluster in one command

Durable execution gives exactly-once within one workflow. It does not give mutual
exclusion between agents that do not know each other exists.
```

Nothing else above the fold. No badges, no table of contents, no architecture
paragraph. GIF, numbers, the two entry points, thesis.

The two lines are deliberately separated and deliberately labelled, because they
serve different readers and the distinction is the one a judge is scanning for. A
judge needs to know that trying this costs them nothing, and they need to know it
before they read a single sentence of prose. A developer needs to know that running it
on their own repository means their own cluster and their own credentials — which is
correct, expected, and not a caveat to bury. Collapsing the two into one install line,
as this screen previously did, reads as though the project requires provisioning
before it can be seen at all.
