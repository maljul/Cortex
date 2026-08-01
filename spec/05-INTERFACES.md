# 05 — Interfaces

Four surfaces over one core library. They are not four products; they are four entry
points to the same `@leasehold/core`.

---

## 1. Core library

```ts
type Decision =
  | { decision: 'granted';  intentId: string; keys: string[]; expiresAt: string }
  | { decision: 'deduped';  ofIntentId: string; holder: string; outcome: Outcome | null }
  | { decision: 'blocked';  contested: Array<{ key: string; holder: string; intentId: string }> };

interface Leasehold {
  recall(repo: string, query: string, k?: number): Promise<Finding[]>;
  propose(repo: string, agentId: string, statement: string, keys: string[]): Promise<Decision>;
  close(repo: string, intentId: string, outcome: Outcome, idempotencyKey: string): Promise<void>;
  release(repo: string, intentId: string): Promise<void>;
  heartbeat(repo: string, intentId: string, extendBy?: string): Promise<void>;
}
```

Design rules the implementer MUST honour:

- `propose` performs dedupe and claim in **one** transaction. Never expose the two as
  separate public methods; someone will call them separately and silently break the
  guarantee.
- Every method is idempotent or explicitly documented as not being so.
- No method accepts SQL, a table name, or any other structural parameter from a caller.
- Errors are typed. A blocked claim is a normal return value, not an exception.
  Exceptions are reserved for infrastructure failure.

## 2. CLI

```
npx leasehold <command>
```

| Command | Purpose | Notes |
| --- | --- | --- |
| `init` | provision a free cluster with ccloud, apply schema, create both service accounts, print the managed-MCP config snippet | the onboarding moment; must work from an empty machine |
| `link` | register the current repository, compute `repo_id` from the git remote | idempotent |
| `serve` | run the local LEASEHOLD MCP server on stdio | what coding agents attach to |
| `run -- <cmd>` | wrap an arbitrary agent process, injecting MCP config | for agents that support MCP config via environment |
| `claim <keys...>` | acquire a claim manually | for humans working alongside agents |
| `recall <query>` | print what the fleet knows | also the fastest way to demo value in a terminal |
| `watch` | local web UI streaming memory changes | same SPA as the hosted demo |
| `bench` | run the proof harness, see `06-BENCHMARK-SPEC.md` | |
| `doctor` | cluster health, audit log tail, schema drift check, TTL job status via ccloud | |

Requirements:

- `init` MUST be safe to run twice.
- Every command MUST support `--json` for machine consumption.
- Exit codes: `0` success, `10` blocked, `11` deduped, `1` error. Distinct codes for
  blocked and deduped let shell-driven agents branch without parsing output.
- No command may print a credential.

`[OPEN]` Node or Python for the CLI. Node gives `npx` with zero install, which
materially affects star conversion and judge friction. Python gives a shorter path to
the embedding and benchmark code. A split (Node CLI, Python bench) is legitimate but
doubles the toolchain. The implementer should pick one runtime for everything and
accept the weaker side, with a mild preference for Node because of `npx`.

## 3. LEASEHOLD MCP server — the write plane

Exposed over stdio locally, and over API Gateway for the hosted demo. **Write
operations only.** Reads deliberately do not live here; they go through the
CockroachDB Cloud Managed MCP Server so that the agent's read access is governed by
Cloud RBAC and audit logging rather than by code you wrote.

### `leasehold_propose`

```json
{
  "name": "leasehold_propose",
  "description": "Declare an intent to modify a resource and request the exclusive right to do so. MUST be called before any file write, migration, or other side effect. Returns granted, deduped, or blocked.",
  "inputSchema": {
    "type": "object",
    "required": ["repo", "agent_id", "statement", "resource_keys"],
    "properties": {
      "repo":          { "type": "string" },
      "agent_id":      { "type": "string" },
      "statement":     { "type": "string", "maxLength": 500,
                         "description": "What you intend to do, in one sentence, specific enough that a teammate could recognise it as the same task." },
      "resource_keys": { "type": "array", "items": { "type": "string" }, "maxItems": 200,
                         "description": "Canonical keys: file:<path>, glob:<pattern>, migration:<id>, service:<name>:<verb>" }
    }
  }
}
```

### `leasehold_close`

```json
{
  "name": "leasehold_close",
  "description": "Record the outcome of an intent and release its claims. Call exactly once per granted intent, including when the work failed.",
  "inputSchema": {
    "type": "object",
    "required": ["repo", "intent_id", "result", "idempotency_key"],
    "properties": {
      "repo":            { "type": "string" },
      "intent_id":       { "type": "string" },
      "result":          { "enum": ["done", "abandoned", "reverted"] },
      "files_changed":   { "type": "array", "items": { "type": "string" } },
      "notes":           { "type": "string", "maxLength": 2000,
                           "description": "What a future agent should know. This becomes durable semantic memory." },
      "tokens_spent":    { "type": "integer" },
      "idempotency_key": { "type": "string" }
    }
  }
}
```

### `leasehold_heartbeat`

Extends the lease on a long-running intent. Without it, long tasks lose their claims
mid-flight and a second agent legitimately acquires them.

### Tool description discipline

The `description` fields are prompt surface, not documentation. They are what makes
an unmodified third-party agent behave correctly. Two rules:

- State the obligation, not the mechanism: "MUST be called before any file write",
  not "inserts a row into the claims table".
- Make the `statement` field description push toward canonical phrasing, because
  dedupe quality depends on paraphrase stability more than on the threshold.

## 4. Agent Skill — `skills/leasehold-memory/SKILL.md`

Published in the repository, installable through the standard skills tooling. It is
what lets an agent use the managed MCP read path without any bespoke client code.

Contents:

1. **When to recall.** Before planning any task touching more than one file.
2. **The exact recall SQL**, parameterised, to issue through the managed MCP server.
   Shipping the query in the skill is what makes the read path work.
3. **When to propose.** Before any side effect, without exception.
4. **How to react to each decision.** `granted` proceed; `deduped` adopt the prior
   outcome and stop; `blocked` re-plan around the contested keys, never poll.
5. **How to write a `notes` field** that will be useful to a stranger in two weeks.
6. **What never to do.** Never write directly to the database. Never bypass propose.
   Never treat a block as an error to retry through.

The project also **consumes** `cockroachlabs/cockroachdb-skills` for schema and query
work. Both directions belong in the B10 answer.

## 5. Demo HTTP API

Only what the SPA needs. Public, anonymous, rate limited.

| Route | Purpose |
| --- | --- |
| `POST /demo/session` | create a sandbox repo scope, returns a session id, rows TTL'd |
| `POST /demo/run` | start a scenario in `replay` or `live` mode |
| `GET /demo/state` | current claims, intents, findings for the session |
| `GET /demo/sql-log` | the actual SQL statements executed, for the "prove it" panel |
| `WSS /demo/stream` | change events fanned out from the changefeed |

`GET /demo/sql-log` is worth building even though it is not strictly necessary. It
lets a sceptical judge see the literal statements behind the animation, which is the
difference between a visualisation and a proof.

## 6. Configuration

```
LEASEHOLD_DSN                 # write-plane connection string, server side only
LEASEHOLD_MCP_ENDPOINT        # https://cockroachlabs.cloud/mcp
LEASEHOLD_REPO                # repo slug
LEASEHOLD_LEASE_TTL           # default 10m
LEASEHOLD_DEDUPE_THRESHOLD    # default 0.28
BEDROCK_REGION
BEDROCK_EMBED_MODEL           # Titan Text Embeddings V2, 1024 dim
BEDROCK_REASON_MODEL          # LIVE mode only
```

No credential is ever read from, or written to, the repository. `leasehold doctor`
MUST fail loudly if a DSN appears in a tracked file.
