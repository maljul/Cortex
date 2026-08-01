# 02 — Compliance Matrix

Audited against the official rules at `https://cockroachdb-ai.devpost.com/rules`
and the overview page, as retrieved 2026-07-31. **Re-check the rules page before
submitting — section 11.5 of the rules allows the sponsor to amend them at any time
and amendments take effect on posting.**

Status key: **OK** satisfied by design · **FIX** required a change to the original
plan, change described · **ACT** an action you must perform manually · **WATCH** a
risk to monitor.

---

## A. Project requirements

| # | Rule clause | How CORTEX satisfies it | Proof artifact | Status |
| --- | --- | --- | --- | --- |
| A1 | Agentic application using CockroachDB as its persistent memory layer | Four memory tiers in one cluster; agents have no other store | `03-MEMORY-MODEL.md` | OK |
| A2 | **Deployed on AWS** | Entire hosted surface on AWS: CloudFront + S3 front end, Lambda backend, API Gateway, EventBridge, CloudWatch. No third-party hosting anywhere | `04-ARCHITECTURE.md` §2 | **FIX** — earlier plan used Vercel. Removed. |
| A3 | All required CockroachDB and AWS components **meaningfully integrated, not just initialized** | Every tool carries a load-bearing function; see §C below | `04` §3, `05-INTERFACES.md` | **FIX** — MCP Server was decorative. Now the agent's sole read path. |
| A4 | At least 2 CockroachDB tools | 4 of 4 used | §C | OK |
| A5 | At least 1 AWS service | 6 used, each load-bearing | §D | OK |
| A6 | Project must install and run consistently on its target platform | CLI targets macOS and Linux, Node 20+; CI matrix proves it | `.github/workflows/ci.yml` | ACT |
| A7 | Project must **function as depicted in the video or text description** | Video is recorded in LIVE mode, not replay mode. Replay is disclosed on screen in the hosted demo | `07-DEMO-AND-SUBMISSION.md` §4 | **FIX** — see WATCH-1 |
| A8 | New projects only, created during the submission period (2026-06-30 to 2026-08-18) | Repository initialised after 2026-07-31; first commit dated | git history | OK |
| A9 | Pre-existing code must be disclosed | README section "Prior work and dependencies" lists anything reused, including personal tooling | README | ACT |
| A10 | Third-party SDK and data use must be licensed | Dependencies audited; `cockroachlabs/cockroachdb-skills` used per its licence | `THIRD-PARTY.md` | ACT |
| A11 | Open-source software may be used provided the project **enhances and builds upon** it | CORTEX extends the CockroachDB skills ecosystem with a new skill rather than repackaging it | `skills/cortex-memory/SKILL.md` | OK |

## B. Submission requirements

| # | Rule clause | Mechanism | Status |
| --- | --- | --- | --- |
| B1 | Public repository with full source, README, dependencies, example config, setup and run instructions | Repo layout per `09-DISTRIBUTION.md` §1 | ACT |
| B2 | Open-source licence **detectable and visible in the About section** | `LICENSE` file, MIT, plus licence set in repo settings so GitHub shows it in About | ACT |
| B3 | URL to a functional demo app | CloudFront URL, zero setup required, no login. No credential input field exists anywhere in the UI, including behind any advanced or developer panel | OK |
| B4 | Working project available **free of charge and without any restriction** for testing until the judging period ends | Demo is public and anonymous, needs no account, no key, no cluster and no card. It writes as `cortex_demo`, a server-side principal confined to TTL'd sandbox scopes (`04` §3), so no visitor ever supplies a credential. Every reachable limit resolves to a working page via the degradation ladder (`04` §5) rather than to an error or a prompt | **FIX** — a BYOK-only demo was arguably a restriction. Resolved by design; the residual risk is availability, not credentials — see WATCH-4 and WATCH-6 |
| B5 | Text description of features and functionality | Devpost description drafted in `07` §6 | ACT |
| B6 | Video under 3 minutes, public on YouTube or Vimeo | Script in `07` §5 | ACT |
| B7 | Video must show the project functioning on its target platform | Terminal footage of the CLI running real agents | OK |
| B8 | Video must show **the CockroachDB memory layer at work** | Split screen: rows, SQL and claim conflicts streaming live | OK |
| B9 | Video must avoid third-party trademarks and copyrighted music | No agent-vendor logos in frame; silent or self-produced audio; blur any tool branding in the terminal | **WATCH-2** |
| B10 | Identify which CockroachDB tools were used **and what the agent actually did with them** | Answer text prepared in §C, written from the agent's point of view | OK |
| B11 | Identify which AWS services were used and how | §D | OK |
| B12 | Optional architecture diagram | Include it. It is free marks on Technological Implementation | ACT |
| B13 | Optional feedback on CockroachDB AI tools | Fill it honestly and in detail. Almost nobody will | ACT |
| B14 | All materials in English | Repo, README, video, description in English | OK |

## C. CockroachDB tool utilisation — answer text for B10

Written to answer the question the form actually asks: *what did the agent do with it?*

**1. CockroachDB Cloud Managed MCP Server** — the agent's **only** read path into its
own memory. Semantic recall, prior-intent lookup and schema introspection are issued
as read-only SQL through the managed endpoint under a service account with `SELECT`
grants only. The agent holds no write credentials at any point. Cloud RBAC scoping
and the server's audit log are the access-control story for the whole system.

**2. Distributed Vector Indexing** — `VECTOR INDEX (repo_id, embedding)` on both
`intents` and `findings`. The prefix column partitions the index per repository, so
recall is scoped to one codebase at the index level rather than by an application
filter. This is what makes the deduplication check cheap enough to run before every
single agent action.

**3. ccloud CLI** — `cortex init` provisions the user's own free cluster, applies
the schema, creates the two service accounts with distinct grants, and prints the
managed-MCP config snippet. `cortex doctor` reads cluster health and audit logs.
Onboarding goes from empty terminal to working memory in one command.

**4. Agent Skills** — two directions. The agent consumes `cockroachlabs/cockroachdb-skills`
for schema and query decisions. CORTEX publishes its own skill,
`cortex-memory`, which carries the exact recall SQL templates and the rule for
when an agent must declare an intent before touching a resource. That skill is what
lets the read path work through the managed MCP server without bespoke client code.

## D. AWS service utilisation — answer text for B11

| Service | Load-bearing function |
| --- | --- |
| **Amazon Bedrock** | Claude via Converse API for agent reasoning in LIVE mode; Titan Text Embeddings V2 (1024 dim) for every intent and finding embedding |
| **AWS Lambda** | the entire write path — typed memory tools behind Function URLs; also the changefeed consumer and the WebSocket fan-out |
| **Amazon S3** | benchmark fixtures, replay cassettes, published benchmark results, static demo assets |
| **Amazon CloudFront** | demo distribution |
| **Amazon API Gateway** | HTTP API for the write path, WebSocket API for the live memory stream, and the ingress for the CockroachDB changefeed webhook sink |
| **Amazon EventBridge** | asynchronous memory consolidation triggered by changefeed events, off the agent's critical path |
| **Amazon CloudWatch + AWS Budgets** | observability, structured logs, and the hard cost ceiling on LIVE mode. The budget action is scoped to the LIVE reasoning function alone, so a cost brake can never take the demo off the air and breach B4 |

Note the discipline: six services, each with one clear job. Do not add a seventh for
appearance. Rule A3 cuts against sprinkling as much as it cuts against omitting.

## E. Open risks

**WATCH-1 — replay versus live.** The rules require the project to function as
depicted. Mitigation: record the video in LIVE mode; the hosted demo defaults to
REPLAY for cost reasons but displays `replay mode: agent reasoning is cached, all
database behaviour is live` and offers a LIVE button. Do not narrate replay footage
as if it were live inference.

**WATCH-2 — trademarks in video.** Terminal recordings of third-party coding agents
will show their names and logos. Use the scripted-agent mode for video capture, or
crop and blur.

**WATCH-3 — availability of features on the free tier.** Three items are unverified
and each has a fallback. Resolve all three in the first working hour; see
`08-BUILD-PLAN.md` §2.

**WATCH-4 — demo longevity.** The demo must remain live, anonymous and free until
2026-09-15. This is now the *only* live part of the B4 story, since the credential
question is closed by design. Weekly, from submission to the end of judging: open the
demo URL in a private browser window on a machine that has never touched this project,
and confirm a scenario runs end to end. Checking that the cluster is unpaused is not
the same test and will not catch a broken deploy, an expired certificate, or a
guardrail that fired and never reset.

**WATCH-6 — guardrail blast radius.** The three brakes in `04-ARCHITECTURE.md` §5 exist
to stop cost running away. Each is also a way to take the demo off the air, and a demo
that is off the air fails B4 no matter how good the reason was. The Budget alarm's
action must target the LIVE reasoning function alone; reserved concurrency must not be
applied to the read or REPLAY paths; the run counter must degrade the mode, never the
service. Verify by firing each brake deliberately, not by reading the configuration.

**WATCH-5 — rules amendments.** Re-fetch the rules page on 2026-08-17 and diff it
against this matrix.

## F. Pre-submission checklist (walk on 2026-08-17)

- [ ] Rules page re-fetched and diffed against this document
- [ ] Repository public, MIT licence visible in the About section
- [ ] README contains setup, run instructions, prior-work disclosure, third-party licences
- [ ] Demo URL loads anonymously in a private browser window, with no key and no login
- [ ] No credential input field exists anywhere in the demo UI, including behind any
      advanced, settings or developer panel
- [ ] All four degradation rungs exercised by forcing the limit, each producing a
      working page rather than an error
- [ ] Each of the three cost brakes fired deliberately, and the demo stayed reachable
- [ ] README and Devpost description both state the zero-setup promise explicitly, and
      both make clear that bring-your-own-credentials applies to the CLI only
- [ ] Weekly anonymous reachability check scheduled through 2026-09-15
- [ ] LIVE mode works and its daily cap degrades gracefully to REPLAY
- [ ] Video under 3:00, public, English, shows terminal and memory layer, no third-party marks
- [ ] Devpost description contains the benchmark table and the architecture diagram
- [ ] B10 and B11 answers pasted from sections C and D
- [ ] Optional feedback field completed in detail
- [ ] AWS Budget alarm active; CockroachDB cluster not near free-tier limits
- [ ] Benchmark results in the repo reproduce from a clean clone
