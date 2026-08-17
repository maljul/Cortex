# Wiring CORTEX into a real agent

CORTEX is not a framework and not an orchestrator. It is a memory layer your agents talk to
over stdio MCP and plain SQL. Your agents keep their own runtime, their own model, their own
prompt and their own loop. Nothing about them changes except that they ask before they write.

Every command on this page was run before it was published. Where something does not work, or
works only under a condition, this page says so rather than leaving you to find out.

- [1. The shape of it](#1-the-shape-of-it)
- [2. Claude Code](#2-claude-code)
- [3. The three write tools](#3-the-three-write-tools)
- [4. The read path](#4-the-read-path)
- [5. Any other MCP-capable agent](#5-any-other-mcp-capable-agent)
- [6. Your own cluster](#6-your-own-cluster)
- [7. What it costs, and what it does not need](#7-what-it-costs-and-what-it-does-not-need)
- [8. What is not built](#8-what-is-not-built)

---

## 1. The shape of it

Two surfaces, deliberately asymmetric.

| | Surface | Principal | What it is for |
| --- | --- | --- | --- |
| **Write** | MCP over stdio — `cortex_propose`, `cortex_close` | `cortex_writer` | declaring an intent and acquiring the right to act on it |
| **Read** | plain SQL, your own client | `cortex_reader` | recalling what the fleet already learned |

The asymmetry is the design. Writes are arbitrated, so they go through a typed tool surface
that can refuse. Reads are not arbitrated, so they go through a SQL grant that cannot write —
proved by attempting the write, not by reading a catalogue. There is no read tool on the MCP
server and a test asserts there never is.

**The rule an agent has to follow is one sentence:** call `cortex_propose` before any file
write, migration, or other side effect, and act only on the keys it granted you.

---

## 2. Claude Code

### Attach

```bash
claude mcp add cortex -- /ABSOLUTE/PATH/TO/cortex/node_modules/.bin/tsx /ABSOLUTE/PATH/TO/cortex/scripts/serve-mcp.mts
```

Substitute your checkout's absolute path twice. Then:

```bash
claude mcp list
```

**Why that exact form, and not the obvious ones.** On stdio MCP, stdout carries JSON-RPC frames
and nothing else — anything else on it is a parse error at the client rather than a log. Six
candidate commands were measured by spawning each, writing an `initialize` frame and reading
stdout:

| Command | stdout | Works from another directory |
| --- | --- | --- |
| `npm run serve` | **2 non-protocol lines** (`> cortex@1.0.0 serve`, `> tsx …`) | — |
| `npm --prefix <path> run serve` | **2 non-protocol lines** | yes |
| `npm run --silent serve` | clean | needs cwd at the repo |
| `npm --prefix <path> run --silent serve` | clean | yes |
| `npx tsx <abs path>` | clean | yes, but **silently downloads `tsx` from the registry** |
| `node --import tsx <abs path>` | clean | **no — fails, `ERR_MODULE_NOT_FOUND`** |
| `<repo>/node_modules/.bin/tsx <abs path>` | clean | **yes** |

The last row is the only one that is clean, needs no particular working directory, and reaches
for nothing over the network. That is why it is the documented form. `npm run serve` is still
the right way to run the server *by hand* — it is only unsuitable as an MCP client's command,
because of npm's own lifecycle banner.

The server writes one diagnostic line, `cortex mcp server listening on stdio`, to **stderr**,
which is correct and which your client will show in its logs.

### What Claude Code needs in the environment

The server reads `.env` from the CORTEX checkout, not from your project, so the variables live
in one place regardless of which repository your agent is working on.

| Variable | Required | What for |
| --- | --- | --- |
| `CORTEX_WRITER_DSN` | **yes** | the `cortex_writer` plane. Without it the server starts and the first tool call fails naming the variable |
| AWS credentials | **yes** | every `cortex_propose` embeds its statement with Bedrock Titan. Resolved through the AWS SDK's default provider chain, not read from `.env` directly |
| `BEDROCK_REGION` | no | defaults to the SDK's own region resolution |
| `BEDROCK_EMBED_MODEL` | no | defaults to `amazon.titan-embed-text-v2:0` |
| `CORTEX_REPO_ROOT` | only for `glob:` keys | the checkout globs are expanded against. Unset, a `glob:` key is refused rather than matched against whatever directory the server happened to start in |

---

## 3. The three write tools

The tool descriptions are prompt surface, not documentation — they are what makes an
unmodified third-party agent behave correctly, and a test holds them byte-for-byte against the
interface spec. Do not reword them in a wrapper.

### `cortex_propose`

Required: `repo`, `agent_id`, `statement`, `resource_keys`. No optional fields; an undeclared
argument is refused.

- `statement` — one sentence, max 500 characters, *specific enough that a teammate could
  recognise it as the same task*. This is the string that gets embedded, and it is the whole
  input to dedupe. A vague statement is the one way to make this system perform badly.
- `resource_keys` — max 200, from a closed grammar: `file:<path>`, `glob:<pattern>`,
  `migration:<id>`, `service:<name>:<verb>`. Absolute paths and `..` are refused. A `glob:`
  claims one row per matched file *plus* the glob itself.
- `repo` is a slug. `cortex_propose` registers one it has not seen; `cortex_close` requires it
  to exist already, because a close can never legitimately be the first thing a repository
  sees and a typo that minted a tenant would send you after the wrong bug.

**Three decisions come back, and none of them is an error.** An agent that treats `blocked` as
a failure and retries will turn your fleet into a queue, which is the exact behaviour this
exists to prevent.

The transcript below is real — two clients, one server each, driven over stdio:

```jsonc
// agent-1 proposes
{ "decision": "granted",
  "intentId": "ef7488be-14e6-4012-b3b2-ec40f2de9e1f",
  "keys": ["file:src/payments/provider.ts"],
  "expiresAt": "2026-08-17T00:51:42.747Z" }

// agent-2 proposes DIFFERENT work on the SAME file
{ "decision": "blocked",
  "contested": [ { "key": "file:src/payments/provider.ts",
                   "holder": "agent-1",
                   "intentId": "ef7488be-14e6-4012-b3b2-ec40f2de9e1f",
                   "expiresAt": "2026-08-17T00:51:42.747Z" } ] }

// agent-3 proposes the SAME work as agent-1, on a different file
{ "decision": "deduped",
  "ofIntentId": "ef7488be-14e6-4012-b3b2-ec40f2de9e1f",
  "holder": "agent-1",
  "status": "in_flight",
  "outcome": null,
  "distance": 0.034158385965332605 }
```

| Decision | What it means | What your agent should do |
| --- | --- | --- |
| `granted` | you hold every key you asked for, until `expiresAt` | do the work, then `cortex_close` |
| `blocked` | someone else holds at least one key | **re-plan, do not poll.** You are told who holds it and which intent, so you can work on something else or wait deliberately |
| `deduped` | this work is already in flight or already done | adopt the prior outcome. `outcome` is `null` while `status` is `in_flight`, and carries the result once it closes |

Acquisition is all-or-nothing: you never get a strict subset of the keys you asked for.

### `cortex_close`

Required: `repo`, `intent_id`, `result` (`done` | `abandoned` | `reverted`), `idempotency_key`.
Optional: `files_changed`, `notes`, `tokens_spent`.

```jsonc
{ "applied": true, "intentId": "ef7488be-…", "status": "done", "releasedKeys": 1 }
```

`applied: false` is a **success**, not a failure — it means this idempotency key was already
delivered, and nothing was released twice. Call close exactly once per granted intent,
**including when the work failed**: `abandoned` is a concluded outcome and it becomes memory,
so the next agent to consider that task learns it was tried.

**`notes` is the field that makes this a memory layer rather than a lock service,** and how you
word it decides whether anyone ever finds it. Measured twice on unrelated pairs: a note naming
the *change you made* sits far outside recall's reach from the task it matters to, while a note
naming *the work the change affects* is retrieved reliably. Write "order creation can now
oversell because availability is cached", not "added a cache".

### `cortex_heartbeat`

Advertised on the wire and **permanently not implemented** — it answers with an error saying
so. Lease extension was cut deliberately in favour of a longer fixed lease. Do not build a
retry loop around it.

---

## 4. The read path

Recall is not an MCP tool. Your agent runs one query as `cortex_reader`, with any Postgres
client, and gets back what the fleet learned.

The query lives in **[`skills/cortex-memory/SKILL.md`](../skills/cortex-memory/SKILL.md)**,
which is a published Agent Skill: point your agent at that file and it has both the SQL and the
instructions for when to run it. The SQL there is pinned byte-for-byte against
`src/memory/recall.ts` by a test, and both of its `repo_id` predicates are asserted separately —
because losing the one on the `LEFT JOIN` was measured ranking one repository's recall on
another's revert history, and a missing tenant filter fails *open*.

Three parameters need explaining:

- **`$1` is your query text, embedded by the same model at the same width as the stored
  vectors** — Titan Text Embeddings V2, 1024 dimensions, normalised. Different model or
  different width and the distances mean nothing. The skill carries an AWS CLI invocation for
  this; nothing in this repository does the step for you.
- **`$2` is the `repo_id` UUID**, not the slug. Resolve it once with
  `SELECT id FROM repos WHERE slug = $1` and cache it.
- **`$4` is the maximum cosine distance.** Its value is `DEFAULT_MAX_DISTANCE` in
  `src/memory/recall.ts`; the skill's parameter table is asserted equal to it by a test, so
  quote it from one of those two places rather than from here.

Results are ordered by `times_reverted DESC` before distance — a fact about work that has been
reverted before outranks a merely closer one, and that ordering is the claim.

Run end to end on 2026-08-17, lifting the SQL out of the published markdown rather than out of
`src/`:

```
connected as: cortex_reader
recall returned 2 row(s)
  dist=0.0000 reverted=0  Cache inventory availability lookups for thirty seconds — done
  dist=0.2295 reverted=0  Add a thirty second cache to inventory stock level lookups — done

write attempted as cortex_reader -> refused, SQLSTATE 42501
```

### Why a SQL grant and not CockroachDB's managed MCP server

The managed MCP server was the intended read path and was dropped after measurement. It
executes as a principal holding INSERT and DELETE on `claims` — established by invoking
`insert_rows` and getting **23502** (not-null violation) rather than **42501** (insufficient
privilege). A read path that can delete claims is not a read path. `cortex_reader` is refused
every write form it is offered, and a test attempts them rather than trusting a grant list.

---

## 5. Any other MCP-capable agent

There is no bespoke client anywhere in this project. The server is stdio MCP, so anything that
speaks the protocol attaches the same way — point your client's command at the same binary and
script path as [§2](#2-claude-code).

The write surface has been driven with the MCP SDK, and separately with a hand-written client
speaking raw newline-delimited JSON-RPC over pipes with no SDK at all. Both get the same three
decisions.

For an agent with no MCP support, the arbitration transaction is reachable in TypeScript as
`propose()` and `close()` from `src/memory/`. You lose the tool schemas and the argument
validation; you keep the single transaction, which is the part that matters.

---

## 6. Your own cluster

```bash
git clone <this repo> && cd cortex
npm ci
node bin/cortex.mjs init
node bin/cortex.mjs doctor
```

**It is `node bin/cortex.mjs`, not `npx cortex`.** The public npm registry carries an unrelated
package under the name `cortex`, so `npx cortex` fetches and runs someone else's code. The
direct form is the one under test.

`init` does **not** provision a cluster. Create a free one at cockroachlabs.cloud, put its
connection string in `.env` as `CORTEX_DSN` — an operator credential, because `init` creates
roles and applies DDL — and then run it. It creates the SQL roles the schema grants to, writes
their connection strings into `.env`, applies the schema, and proves each privilege plane **by
attempting statements against it**: the reader must be refused a write with 42501, the writer
must be refused DDL. It is safe to run twice; an existing role is left alone and no password is
ever rotated.

`doctor` reports what `.env` carries (key names and character counts — never a value), which
planes connect and as whom, which tables the cluster has, and whether a connection string has
leaked into a tracked file. It exits 1 if one has.

No command in this project prints a credential.

---

## 7. What it costs, and what it does not need

**Does not need:** a framework, an orchestrator, a scheduler, a message bus, a sidecar, or any
change to how your agents are written. No long-lived process of ours runs anywhere.

**Costs, per proposal:** one Bedrock Titan embedding of your statement, and one SERIALIZABLE
transaction. The embedding is cached by content hash, in-flight-deduplicated, and collapsed
within a batch, so a repeated statement does not re-embed. The dedupe search and the claim
insert share **one** transaction — if they are ever split across two, the thesis of this project
is falsified by its own code, which is why a test counts the `BEGIN`s.

**Costs, per recall:** one embedding and one indexed vector query. Nothing is written.

**Latency:** a propose is dominated by round trips, so it is worth measuring from where your
agents actually run. The same run takes ~6–9s in-region against ~50s from a laptop across the
Atlantic. Any wall-clock number quoted in this repository is the laptop figure unless it says
otherwise.

**Contention:** a write path that hits a serialization failure retries with exponential backoff
and jitter, up to a cap. An agent that exhausts the cap re-plans once rather than erroring.

---

## 8. What is not built

Named here because a page that only lists what works is not a page you can plan against.

- **`cortex_heartbeat`** answers with an error. Lease extension is cut; use the fixed lease.
- **Recall has no MCP surface**, by design. You bring a Postgres client and an embedding call.
- **Nothing resolves a slug to its `repo_id` for you** — no command, no route. One `SELECT`.
- **`CORTEX_REPO` appears in the skill and the interface spec and is read by no code.** The repo
  slug reaches the server as the `repo` tool argument instead. Do not set it expecting an effect.
- **`CORTEX_LEASE_TTL`** has had no reader since lease extension was cut. The lease is fixed in
  `src/memory/propose.ts`.
- **The embedding cache is per-process.** A fleet spread across machines re-embeds per machine.
  A shared cache needs a table the memory model does not define, so it was left undefined rather
  than invented.
- Of the interface spec's nine CLI commands, **two are built** — `init` and `doctor`. `cortex
  serve` exits 1 and tells you to run `npm run serve`; a subcommand that silently did nothing
  would be worse than one that does not exist.
