# 01 — Project Brief

## 1. Product definition

**LEASEHOLD** is a shared memory layer for fleets of coding agents working on the
same repository. It gives every agent in the fleet one durable brain: what has been
learned about this codebase, what is being attempted right now, what was tried
before and failed. Every write to that brain is arbitrated inside a single
SERIALIZABLE transaction, so two agents can never act on contradictory beliefs and
never redo each other's work.

**Tagline:** shared, arbitrated memory for agent fleets.

**Not** a lock service. Not an orchestrator. Not another agent framework. It sits
underneath whatever agents the user already runs.

## 2. The problem, stated precisely

Running several coding agents in parallel on one repository is now normal practice.
Three failure modes appear immediately, and none of them are model-quality problems:

1. **Redundant rediscovery.** Agent B spends real tokens learning what agent A
   learned four minutes ago, because neither has access to the other's findings.
2. **Duplicate work.** Two agents independently decide to implement the same thing.
   One of the two outputs is discarded. The tokens are not.
3. **Conflicting side effects.** Two agents edit overlapping regions, or run the same
   migration twice, and the later write silently destroys the earlier one.

Published measurements on multi-agent coding coordination report the duplicate-work
share falling from 0.78 to 0.00 and useful throughput more than tripling when a
shared substrate with advisory leases plus shared task state is introduced, and note
that file-based trackers silently lose concurrent writes. Critically, the same work
finds that **leases alone do not eliminate redundant rediscovery — leases plus shared
state do.** That finding is the architectural thesis of LEASEHOLD.

Source to cite in the README: arXiv 2606.19616, "Before the Pull Request: Mining
Multi-Agent Coordination". `[VERIFY]` — re-read the paper before quoting any number
in the submission, and cite only numbers you have reproduced in your own benchmark.

## 3. Why this cannot be built on the usual stack

The decisive property is that **the semantic deduplication check and the acquisition
of the right to act happen in one transaction, on one snapshot.**

With a separate vector store plus a separate lock service you can pass the dedupe
check against a stale index and then acquire a lease for work that has already been
completed. That is the dual-write bug, and in this domain it is denominated in the
user's tokens. There is no application-level workaround, because the two systems
have no common commit point.

Everything else follows from the same property: findings and the intent that produced
them commit together, so the memory can never contain a fact whose originating action
was rolled back.

**The falsification test to keep in mind at every design decision:**
*if I swapped CockroachDB for Pinecone plus Postgres plus Redis, would the demo still
prove its point?* If yes, the design has drifted. Go back.

## 4. Prior art and how we differ

| Category | Representative | What it solves | What it leaves open |
| --- | --- | --- | --- |
| Durable execution | Temporal, Restate, Inngest, DBOS, Cloudflare Workflows | exactly-once and crash resume **within one workflow** | mutual exclusion **across** independently spawned agents |
| Graph-state frameworks | LangGraph | races inside one graph, via reducers | agents that are not in one graph and do not know each other |
| Agent memory layers | Mem0, Zep, Memori, Letta | semantic recall across sessions | memory writes are not decisions; no arbitration |
| Unified-substrate marketing | Tacnode, MongoDB, Oracle | states the thesis | no falsifiable proof harness |
| Vendor reference story | Cockroach Labs' own Memori integration | generic agent memory on CockroachDB | already told by the sponsor — do not repeat it |

**The gap we occupy:** no product or open-source project arbitrates *side-effecting
actions* between concurrently running LLM agents using database-level SERIALIZABLE
leases co-located with the semantic memory, and none ships a reproducible harness
that measures what breaks without it.

Say this explicitly in the README. Demonstrating that you know the landscape scores
on Technological Implementation and Creativity simultaneously. Pretending the
landscape is empty gets you caught.

## 5. Mapping to the judging criteria

The five criteria are **equally weighted**, and ties are broken starting with
Agentic Memory Design. That ordering drives the entire narrative.

| Criterion | Our primary evidence | Where it lives |
| --- | --- | --- |
| **Agentic Memory Design** | four memory tiers, cross-session recall, consolidation via changefeed, vector index partitioned per repo, memory writes that are also decisions | `03-MEMORY-MODEL.md` |
| **Technological Implementation** | split read/write privilege planes, 40001 retry, all-or-nothing multi-key claims, idempotency ledger, typed MCP contracts | `03`, `05` |
| **Real-World Impact** | measured token and rework savings on a workload thousands of developers run today | `06-BENCHMARK-SPEC.md` |
| **Product Readiness** | read-only agent credentials, audit logging, TTL reclamation of dead agents' claims, budget guardrails, observability, documented failure modes | `04-ARCHITECTURE.md` |
| **Creativity & Originality** | arbitration as a property of the memory layer rather than of the orchestrator | `01`, README |

### The narrative risk you must actively manage

A lease table reads as a lock service. If a judge parses LEASEHOLD as "distributed
locks for agents", Agentic Memory Design scores low and every tie is lost. The
counter-measure is a fixed **3:1 ratio of memory to arbitration** in every artifact.
The demo, the video and the README all present four operations in this order:

1. **Recall** — agent starts a task and receives findings from a session two weeks
   ago. This is the proof of long-term memory.
2. **Dedupe** — agent declares an intent, vector search shows someone is doing it
   right now, agent stands down before spending a token.
3. **Claim** — only now arbitration, framed as the mechanism that protects the
   memory's integrity.
4. **Consolidate** — a closed intent is distilled into a durable fact via changefeed.

## 6. Non-goals

Explicitly out of scope, and stated as such in the README so it reads as judgement
rather than omission:

- Building an agent or an agent framework. LEASEHOLD wraps agents the user already has.
- Multi-region deployment. The free tier cannot demonstrate it honestly. Describe the
  `REGIONAL BY ROW` production path in one README paragraph and leave it there.
- Authentication, billing, multi-user onboarding. One hardcoded tenant, but `repo_id`
  present in the vector index key so the isolation mechanism is visible in the code.
- Fine-tuning or custom models.
- Selling crash-resume as an innovation. Durable execution solved that; keep the kill
  switch in the demo as a ten-second hygiene proof, not as a thesis.

## 7. Success definition

- **Necessary:** submission is eligible, demo reachable and free through 2026-09-15,
  video under three minutes showing the memory layer at work, benchmark table in the
  Devpost description.
- **Target:** top three.
- **Independent of placing:** a public repository with a reproducible benchmark that
  stands on its own as portfolio evidence, and a content asset that cannot be faked
  by anyone who did not build the system.
