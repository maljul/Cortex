---
name: cortex-memory
description: Use before planning any task that touches more than one file, and before any side effect, in a repository coordinated by CORTEX. Recall what the fleet already knows, then propose your intent and act only on the answer.
---

# CORTEX — shared memory and arbitration for a fleet of agents

You are one of several agents working on this repository at the same time. The others
are not visible to you and are not waiting for you. Everything below exists because two
agents doing the same work, or editing the same file at the same time, is the normal
case rather than the unlucky one.

Two surfaces, and they are not interchangeable:

| | Read | Write |
| --- | --- | --- |
| What | recall SQL, issued as `cortex_reader` | the `cortex_*` MCP tools |
| Over | `CORTEX_READER_DSN` | the CORTEX MCP server on stdio |
| Can it change anything | no — the grant is `SELECT` only | yes, and only through arbitration |

---

## 1. When to recall

**Before planning any task touching more than one file.** Also before repeating work
that sounds like something a colleague might already have done, and before acting on an
assumption about code you have not read in this session.

Recall is cheap and read-only. Skipping it is how you rediscover, at length, something
another agent recorded an hour ago — including that a change like yours was made and
then reverted.

## 2. The exact recall SQL

Issue this as `cortex_reader` over `CORTEX_READER_DSN`, with any ordinary Postgres
client. Do not retype it, do not "simplify" it, and do not build it by string
concatenation.

```sql
WITH near AS (
  SELECT id, fact, source_intent_id, confidence, contradictions,
         embedding <=> $1 AS dist
  FROM findings
  WHERE repo_id = $2
  ORDER BY embedding <=> $1
  LIMIT $3
)
SELECT n.fact,
       n.confidence,
       n.dist,
       count(i.id) FILTER (WHERE i.outcome->>'result' = 'reverted') AS times_reverted,
       max(i.closed_at)                                             AS last_touched
FROM near n
LEFT JOIN intents i ON i.id = n.source_intent_id AND i.repo_id = $2
WHERE n.dist < $4
GROUP BY n.fact, n.confidence, n.dist
ORDER BY times_reverted DESC, n.dist ASC
LIMIT $5
```

| Parameter | Meaning | Sensible value |
| --- | --- | --- |
| `$1` | your query, embedded — a 1024-dimension vector as `[a,b,c,…]` | see below |
| `$2` | `repo_id`, the tenant boundary | the UUID for this repository |
| `$3` | how many neighbours the vector index returns before the join | `40` |
| `$4` | maximum cosine distance; past this it is noise, not memory | `0.60` |
| `$5` | how many rows reach your context | `8` |

**Both `repo_id` predicates are load-bearing and neither is optional.** One scopes the
vector search; the other scopes the join onto `intents`, because a finding carries no
foreign key and so can name an intent in another repository. Dropping either does not
raise an error — it silently returns or ranks on another tenant's rows. If you find
yourself editing this query, stop and ask a human.

**Getting `$1`.** Embed your query text with Amazon Titan Text Embeddings V2 at 1024
dimensions, normalised — the same model and width the stored vectors use, or the
distances are meaningless. Any standard client will do, for example the AWS CLI:

```
aws bedrock-runtime invoke-model \
  --model-id amazon.titan-embed-text-v2:0 \
  --body '{"inputText":"<your query>","dimensions":1024,"normalize":true}' \
  --cli-binary-format raw-in-base64-out /dev/stdout
```

**Reading the answer.** Rows arrive most-reverted first, then nearest. A high
`times_reverted` is the strongest signal in the result: someone already tried this and
it did not hold. Treat that row as a warning about your plan, not as trivia.

## 3. When to propose

**Before any side effect, without exception.** Editing a file, running a migration,
opening a pull request, calling an external API — propose first, act only on the
answer. Recall tells you what is known; it does not reserve anything and it does not
tell you what another agent started thirty seconds ago.

Call `cortex_propose` with your repository, your agent id, a one-sentence statement of
what you intend to do, and the resource keys you will touch (`file:src/auth/login.ts`,
or `glob:src/auth/**`). Ask for **every** key you will touch, in one call. You are
granted all of them or none — a partial claim is refused on purpose, because
half-ownership produces interleaved half-edits.

## 4. How to react to each decision

**`granted`** — the keys are yours until `expiresAt`. Do the work. Call `cortex_close`
exactly once when you are finished, with `done`, `abandoned` or `reverted`, the files
you changed, and a `notes` field. Closing releases the claims; not closing leaves them
held until the lease lapses.

**`deduped`** — someone already did this, or is doing it now. The decision carries their
outcome. **Adopt it and stop.** Do not redo the work to check; do not "just verify".
The outcome is the answer to your task, and if it says the work was reverted, that is
still the answer.

**`blocked`** — another agent holds one or more of your keys. The decision names the
holder, their intent, and when their lease expires. **Re-plan around the contested
keys**: work on something else, split your task to touch only the keys you can get, or
wait for the named expiry if there is genuinely nothing else to do.

**Never poll, and never retry through a block.** A block is a normal return value, not
an error. Retrying it in a loop turns a fleet into a queue, which is the exact failure
the arbitration exists to prevent.

## 5. How to write a `notes` field

Write for a stranger reading it in two weeks with none of your context. That stranger is
usually another agent, deciding whether your work answers its task.

- Say what you changed and, more importantly, **why** — the constraint, not the diff.
- Name anything you discovered that is not visible in the code: a surprising coupling,
  an API that lies, a test that only passes in one order.
- Say what you deliberately did **not** do, and why. That is the most valuable sentence
  in most notes and the one most often left out.
- Do not restate the file list. It is already recorded in `files_changed`.

Bad: `fixed the login bug`. Good: `session cookie was set before the CSRF token was
rotated, so a login immediately after a logout reused the old token; rotating first
fixes it. Left the legacy /auth/v1 path alone — it has its own token flow and no tests.`

## 6. What never to do

- **Never write directly to the database.** Not through `psql`, not through any MCP
  server that offers an insert tool, not "just this once to fix the state". The read
  credential is `SELECT`-only and will refuse you; if you find a path that does not
  refuse you, that path is a bug and you should report it rather than use it. Every
  invariant this system has is bypassed — not broken, bypassed — by an agent that writes
  to `claims` or `intents` itself.
- **Never bypass propose.** No side effect without a decision, including a change you
  are certain is trivial and including one you are about to revert.
- **Never treat a block as an error to retry through.** See section 4.
- **Never invent the recall SQL.** Use the query in section 2 as written.

---

## Configuration

Two environment variables, and this file contains the value of neither:

| Variable | What it names |
| --- | --- |
| `CORTEX_READER_DSN` | the read plane, connecting as `cortex_reader` |
| `CORTEX_REPO` | this repository's slug, resolved to the `repo_id` you pass as `$2` |

If a credential ever appears in this file, in an example, in a comment, or behind a
flag, that is a defect — report it and do not use the file.
