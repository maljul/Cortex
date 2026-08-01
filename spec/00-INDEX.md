# LEASEHOLD — Specification Package

**Project:** LEASEHOLD — shared, arbitrated memory for fleets of coding agents
**Target:** CockroachDB × AWS Hackathon — Build with Agentic Memory
**Submission deadline:** 2026-08-18, 17:00 EDT (23:00 CEST)
**Judging period ends:** 2026-09-15 — the demo must stay live and free until then
**Status of this package:** v1.0, rules-audited against the official rules page

---

## Why the package is split this way

Documents are separated by **reader and change frequency**, not by topic. The
schema file is opened on every implementation step; the brief is read once. Mixing
them causes context bloat for the implementing agent and drift for the human.

| File | Primary reader | Read frequency | Changes |
| --- | --- | --- | --- |
| `01-PROJECT-BRIEF.md` | you, judges (indirectly) | once, then on doubt | rarely |
| `02-COMPLIANCE-MATRIX.md` | you | before submission | when rules re-checked |
| `03-MEMORY-MODEL.md` | implementing agent | constantly | frequently early |
| `04-ARCHITECTURE.md` | implementing agent | per component | rarely after day 1 |
| `05-INTERFACES.md` | implementing agent, users | constantly | frequently early |
| `06-BENCHMARK-SPEC.md` | implementing agent | day 2 | once |
| `07-DEMO-AND-SUBMISSION.md` | you | day 3 | once |
| `08-BUILD-PLAN.md` | you | daily | daily |
| `09-DISTRIBUTION.md` | you | after submission | rarely |
| `10-KICKOFF-PROMPT.md` | implementing agent | once per session | rarely |

## How to use it

1. Read `01` and `08` yourself. Everything else is reference material.
2. Start every Claude Code session by pasting `10-KICKOFF-PROMPT.md`.
3. Load `03` and `05` into the agent's context for implementation work. Load `04`
   only when touching deployment. Never load all files at once.
4. `02` is the pre-submission checklist. Walk it line by line on 2026-08-17.

## Language

These specs are in English on purpose. The rules require all submission materials
to be in English, and these documents are the source text for the public README,
the Devpost description, and the video script. Tell me if you would rather keep the
internal-only ones (`01`, `08`, `09`) in Polish.

## Specification conventions

- **MUST / SHOULD / MAY** carry RFC 2119 meaning.
- **`[VERIFY]`** marks a claim that has not been confirmed against a live cluster or
  a primary source. Every `[VERIFY]` item has a named fallback. Do not build on a
  `[VERIFY]` item without checking it first.
- **`[OPEN]`** marks a decision left to the implementer or to you. Each `[OPEN]`
  states the trade-off in full rather than presenting bare options.
- Specs define **contracts and invariants**, not implementations. Where the how is
  genuinely free (backoff curve, UI layout, prompt wording), the spec states the
  desired outcome and constraints and leaves the design to the implementing agent.

## The one-sentence version

> Durable execution gives exactly-once **within** a single workflow. It does not give
> mutual exclusion **between** agents that do not know each other exists. LEASEHOLD
> moves both memory and arbitration into one CockroachDB cluster: an agent does not
> receive the right to act from an orchestrator, it wins that right in a SERIALIZABLE
> transaction against the same rows that hold its semantic memory.
