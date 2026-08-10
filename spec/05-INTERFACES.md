# 05 — Interfaces

Four surfaces over one core library. They are not four products; they are four entry
points to the same `@cortex/core`.

---

## 1. Core library

```ts
type Decision =
  | { decision: 'granted';  intentId: string; keys: string[]; expiresAt: string }
  | { decision: 'deduped';  ofIntentId: string; holder: string; outcome: Outcome | null;
                            status: string; distance: number }
  | { decision: 'blocked';  contested: Array<{ key: string; holder: string; intentId: string;
                                              expiresAt: string }> };

interface Cortex {
  recall(repo: string, query: string, k?: number): Promise<Finding[]>;
  propose(repo: string, agentId: string, statement: string, keys: string[]): Promise<Decision>;
  close(repo: string, intentId: string, outcome: Outcome, idempotencyKey: string): Promise<void>;
  release(repo: string, intentId: string): Promise<void>;
  heartbeat(repo: string, intentId: string, extendBy?: string): Promise<void>;
}
```

`status`, `distance` and the contested `expiresAt` were added 2026-08-10 to match what
`cortex_propose` actually returns. They are what make a decision actionable rather than
merely informative: `expiresAt` is how a blocked agent decides between re-planning and
coming back, which is the whole purpose of telling it who holds the key.

Note that the field names here and in `03` §4.2 differ — `ofIntentId` against `of`,
`key` against the `resource_key` the SQL returns. Both are honoured, each in its own
layer: the core library keeps §4.2's names because it *is* that transaction, and the
MCP boundary translates to the names above, because this is where the shape an agent
codes against is written down. See `docs/SPEC-DELTA.md`.

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
npx cortex <command>
```

| Command | Purpose | Notes |
| --- | --- | --- |
| `init` | provision a free cluster with ccloud, apply schema, create both service accounts, print the managed-MCP config snippet | the onboarding moment; must work from an empty machine |
| `link` | register the current repository, compute `repo_id` from the git remote | idempotent |
| `serve` | run the local CORTEX MCP server on stdio | what coding agents attach to |
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

**Node, everywhere.** *(Decided 2026-08-10; was `[OPEN]` between Node and Python.)* Node
gives `npx` with zero install, which materially affects star conversion and judge
friction, and the install line is on the README's first screen where the benchmark is
not. Python would have given a shorter path to the embedding and benchmark code; that is
the weaker side, and it is accepted. A split runtime was legitimate on paper and doubles
the toolchain on a three-day budget.

By the time the question was formally closed it was not really a choice any more: every
line of `src/`, `bench/`, `scripts/` and `test/` is Node and TypeScript, and B1 committed
the whole tree to one module system with `npx tsc --noEmit` clean. Picking Python here
would have meant *adding* a toolchain rather than choosing between two. Reasoning in
`docs/DECISIONS.md`.

## 3. CORTEX MCP server — the write plane

Exposed over stdio locally, and over API Gateway for the hosted demo. **Write
operations only.** Reads deliberately do not live here; they are issued as
`cortex_reader`, a principal that holds `SELECT` on the six tables and no write verb,
so the agent's read access is bounded by a grant rather than by code you wrote.

*(Changed 2026-08-10.)* Reads went through the CockroachDB Cloud Managed MCP Server
until V17 measured that server writing to `claims`. See `04` §3; the short version is
that it executes as a principal holding `INSERT` and `DELETE` there, and publishes
`insert_rows` as a tool. "Governed by Cloud RBAC" was the argument for that route and
it did not survive being invoked.

### `cortex_propose`

```json
{
  "name": "cortex_propose",
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

### `cortex_close`

```json
{
  "name": "cortex_close",
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

### `cortex_heartbeat`

Extends the lease on a long-running intent. Without it, long tasks lose their claims
mid-flight and a second agent legitimately acquires them.

```json
{
  "name": "cortex_heartbeat",
  "description": "Extend the lease on an intent you still hold. MUST be called before the lease expires on work that runs longer than one lease, or the claims are released and another agent may legitimately acquire them.",
  "inputSchema": {
    "type": "object",
    "required": ["repo", "intent_id"],
    "properties": {
      "repo":      { "type": "string" },
      "intent_id": { "type": "string" },
      "extend_by": { "type": "string",
                     "description": "How much longer the work needs, as a duration such as \"10m\". Defaults to one full lease." }
    }
  }
}
```

The field list is §1's `heartbeat(repo, intentId, extendBy?)` — this block was added
after U7 found the schema missing here, and matches that signature rather than
introducing a new one.

**On the cut list.** `08` §6 item 6: if time runs short, do not implement lease
extension. Ship a longer fixed lease instead and leave this tool advertised but
unimplemented. The schema is settled so that decision stays a scheduling one.

### Tool description discipline

The `description` fields are prompt surface, not documentation. They are what makes
an unmodified third-party agent behave correctly. Two rules:

- State the obligation, not the mechanism: "MUST be called before any file write",
  not "inserts a row into the claims table".
- Make the `statement` field description push toward canonical phrasing, because
  dedupe quality depends on paraphrase stability more than on the threshold.

## 4. Agent Skill — `skills/cortex-memory/SKILL.md`

Published in the repository, installable through the standard skills tooling. It is
what lets an agent use the read path without any bespoke client code.

Contents:

1. **When to recall.** Before planning any task touching more than one file.
2. **The exact recall SQL**, parameterised, to issue as `cortex_reader`. Shipping the
   query in the skill is what makes the read path work. It MUST carry **both**
   `repo_id` predicates that `03` §4.1 specifies — the one in the CTE and the one on
   the join — and it must be pinned against `src/memory/recall.ts` rather than
   retyped, so the filter cannot drift out of it. V14 measured what a missing join
   predicate does: repo A's recall ranked on repo B's revert history.
3. **When to propose.** Before any side effect, without exception.
4. **How to react to each decision.** `granted` proceed; `deduped` adopt the prior
   outcome and stop; `blocked` re-plan around the contested keys, never poll.
5. **How to write a `notes` field** that will be useful to a stranger in two weeks.
6. **What never to do.** Never write directly to the database. Never bypass propose.
   Never treat a block as an error to retry through.

The project also **consumes** `cockroachlabs/cockroachdb-skills` for schema and query
work. Both directions belong in the B10 answer.

## 5. Demo HTTP API

Only what the SPA needs. Public, anonymous, rate limited. Served by the `cortex_demo`
principal, whose confinement is specified in `04-ARCHITECTURE.md` §3.

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

Contracts on this surface, all of which follow from rule B4:

- **No route MAY accept a credential in any field, under any name, on any path.** Not
  a DSN, not an API key, not an AWS role ARN, not a "bring your own model" override.
  A request carrying a credential-shaped field MUST be rejected rather than honoured.
  The rule is absolute because the failure is: once the field exists, somebody pastes
  a live key into a stranger's web form.
- `POST /demo/run` MUST NOT fail when the LIVE quota is exhausted. It returns a
  `replay` run together with the reason it is not `live`. Exhaustion is a normal
  return value, exactly as a blocked claim is in §1.
- The current mode, the reason for it, and the session's remaining row budget MUST be
  readable by the SPA, so that the interface can render a degraded state truthfully
  instead of discovering it through a failed request.
- Every degradation rung in `04-ARCHITECTURE.md` §5 MUST be expressible through these
  routes without an error status. A judge who arrives at a capped demo sees a working
  page that explains itself.

## 6. Configuration

```
CORTEX_DSN                 # write-plane connection string, server side only
CORTEX_READER_DSN          # read-plane connection string, cortex_reader, SELECT only
CORTEX_DEMO_DSN            # hosted demo only, cortex_demo principal, server side only
CORTEX_MCP_ENDPOINT        # diagnostics only since V17 — NOT the read path
CORTEX_MCP_CLUSTER_ID      # the mcp-cluster-id header; from the Console cluster URL
CORTEX_MCP_API_KEY         # bearer token of a Cloud service account, not a SQL user
CORTEX_REPO                # repo slug
CORTEX_REPO_ROOT           # checkout to expand glob: keys against; unset means refuse
CORTEX_LEASE_TTL           # default 10m
CORTEX_DEDUPE_THRESHOLD    # default 0.28
BEDROCK_REGION
BEDROCK_EMBED_MODEL           # Titan Text Embeddings V2, 1024 dim
BEDROCK_REASON_MODEL          # LIVE mode only
```

**The three `CORTEX_MCP_*` values no longer configure the read path.** They are kept
because `npm run probe:read` uses them to re-measure the managed server's reach, which
is worth being able to repeat, and because the demo narrative may still show it. The
read path is `CORTEX_READER_DSN`. Do not reintroduce the managed server as the route
without re-running that probe — V17 is why.

For the probe, the endpoint alone reaches nothing. Its client configuration is the URL
plus an `mcp-cluster-id` header and an `Authorization: Bearer` token, and that token
belongs to a **Cloud service account** — an organization-level identity created in the
Console, distinct from the SQL users in `04` §3, and governed by Cloud roles rather
than by `GRANT`. A new service account starts as Organization Member, which carries no
permissions at all; until it is given a cluster-scoped role every SQL tool answers
`unauthorized` and `list_clusters` returns nothing (V10). At **Cluster Operator** the
SQL tools run, and what they can then do is V17.

`CORTEX_REPO_ROOT` is what makes the `glob:` half of §3's `resource_keys` grammar
usable. `03` §3 requires a glob to be claimed as one row per matched file plus a row
for the glob itself, which needs a checkout to match against; a server launched from an
arbitrary working directory has none, so with this unset the tool refuses the key
rather than resolving it against the wrong tree.

No credential is ever read from, or written to, the repository. `cortex doctor`
MUST fail loudly if a DSN appears in a tracked file.

Every value above is server side. **None is ever sent to the browser, and none is
ever accepted from it.** Bring-your-own-credentials is correct for the CLI, where a
user provisions their own cluster for their own repository and supplies
`CORTEX_DSN` themselves. It is never correct for the hosted demo, where the visitor
is an anonymous judge who has been promised a working project with no setup.
