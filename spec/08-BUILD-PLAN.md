# 08 — Build Plan

Budget: roughly 60 working hours across three days, with slack before the
2026-08-18 deadline. Do not plan to finish on the deadline; plan to finish two days
early and spend the remainder on the video and the description, which are scored
directly.

---

## 1. Ordering principle

Build in order of **irreversibility**, not in order of visibility. The schema and the
arbitration transaction constrain everything downstream; the UI constrains nothing.
Anything you build before verifying the unverified assumptions may have to be thrown
away, so those come first.

The deliberate consequence: **the demo UI is built last, on day three.** This feels
wrong because the UI is what judges see. It is correct because a beautiful UI over an
unproven mechanism is the most common way these submissions fail.

## 2. Hour zero to two — verification gate

Nothing else starts until these three resolve. Each has a fallback in
`04-ARCHITECTURE.md` §8, so none can block you, but discovering a fallback on day
three is expensive and on day one is free.

- [ ] **V1** Enable `feature.vector_index.enabled`, create a `VECTOR INDEX` with a
      prefix column on the free tier, insert and query. Record whether it worked.
- [ ] **V2** Create a changefeed with a webhook sink pointed at a throwaway endpoint.
      If unavailable, switch to the scheduler-polling fallback immediately and note it.
- [ ] **V3** Run a historical query and establish how far back it reaches. Decide on
      the spot whether the time-travel panel survives.
- [ ] Confirm Bedrock model access is enabled in your region for both the embedding
      model and the reasoning model. Model access is per-account and per-region and is
      a classic day-three surprise.
- [ ] Create the two service accounts with distinct grants. If this is awkward, learn
      it now, because the privilege-plane story is a scored differentiator.

Write the outcome of each check into `docs/verification-log.md` and commit it. That
file later becomes the feedback you submit in the optional field.

## 3. Day one — the mechanism

| Block | Work | Done when |
| --- | --- | --- |
| 2–5h | schema applied, migrations runnable from clean | `cortex init` produces a working cluster twice in a row |
| 5–9h | retry helper, typed repository layer, no SQL outside it | forced `40001` retries and commits, covered by a test |
| 9–14h | the arbitration transaction, all eight invariant tests from `03` §8 | all eight pass |
| 14–16h | embeddings via Bedrock, content-hash cache | repeated intent does not re-embed |

**End-of-day gate:** two processes in two terminals contend for one key, one wins, the
loser prints the winner's identity. If this does not work, day two does not start.

## 4. Day two — the proof

| Block | Work | Done when |
| --- | --- | --- |
| 16–20h | CORTEX MCP server, three write tools, stdio transport | a real coding agent attaches and successfully proposes |
| 20–23h | Agent Skill with recall SQL; read path through the managed MCP server verified end to end | agent recalls without any bespoke client |
| 23–29h | benchmark harness: fixtures, task list, five-agent runner, cassettes | `cortex bench` runs both arms deterministically |
| 29–32h | metrics, offline duplicate judge, results writer | `bench/results/` populated and committed |

**End-of-day gate:** the summary table exists and shows a real difference between the
arms. From this moment you have a submittable project even if everything else fails.

## 5. Day three — the surface

| Block | Work | Done when |
| --- | --- | --- |
| 32–38h | infra as code, deploy to AWS, changefeed to WebSocket path live | hosted demo reachable anonymously |
| 38–44h | demo SPA, three panels, naive toggle, show-SQL panel | the four beats read clearly to someone who has not seen it |
| 44–47h | guardrails: reserved concurrency, run counter, budget alarm; all four degradation rungs | each rung forced deliberately and each produces a working page; each brake fired deliberately and the demo stayed reachable; no credential field anywhere in the UI; demo loads in a private window on a machine that never touched the project |
| 47–52h | README, architecture diagram, licence, third-party disclosure | a clean clone reproduces the benchmark |
| 52–58h | video recorded in LIVE mode, edited under 3:00 | uploaded, public, captioned |
| 58–60h | Devpost description, B10 and B11 answers, feedback field | walk the checklist in `02` §F |

## 6. Cut list

Ranked by what to abandon first when time runs short. Cutting from the top costs
almost nothing; cutting from the bottom costs the submission.

1. Time-travel panel
2. OpenTelemetry export
3. `cortex run` process wrapper, keep `serve`
4. Glob expansion beyond a fixed depth
5. Threshold sweep, publish a single value and say it was not tuned
6. Heartbeat and lease extension, use a longer fixed lease
7. Live mode entirely, ship replay only and record the video locally. This does not
   endanger rule B4: a replay-only demo is still a working project available free and
   without restriction, because REPLAY runs fully live database behaviour. What would
   endanger B4 is shipping LIVE without its degradation rung
8. **Never cut:** the arbitration transaction, the benchmark, the naive toggle, the
   README first screen, the video, and anonymous zero-setup access to the demo

## 7. Risk register

| Risk | Likelihood | Impact | Response |
| --- | --- | --- | --- |
| A verification item fails | medium | low | fallbacks are pre-specified; log and proceed |
| Deployment eats day three | medium | **high** | deploy a hello-world through the full pipeline on day one evening, not on day three |
| Benchmark shows no difference | low | **high** | it means task overlap is too low; increase the overlapping-task share and say so in the methodology |
| Demo cost runs away | low | medium | three independent brakes; verify each fires |
| Agents behave inconsistently in the video | medium | medium | record in scripted-agent mode, which is also the trademark mitigation |
| Free-tier cluster paused during judging | medium | **high** | weekly anonymous end-to-end check between 2026-08-19 and 2026-09-15, in a private window, not merely a console glance at cluster status |
| A cost brake takes the whole demo down rather than just LIVE | medium | **high** | scope each brake to the LIVE reasoning function and fire each one deliberately before submitting; see `02` WATCH-6 |
| Rules amended | low | high | re-fetch and diff on 2026-08-17 |
| Scope creep into building an agent framework | **high** | high | the non-goals list in `01` §6 is the veto; re-read it whenever a new idea feels exciting |

The last one is the real threat. Everything in this project invites a tempting
adjacent feature. The submission is won by depth on one mechanism, not breadth.

## 8. Open decisions

Each is genuinely open, with the trade-off stated in full rather than as a bare choice.

**D1 — Runtime.** Node makes `npx cortex` work with zero install, which measurably
affects both judge friction and star conversion, but pushes the benchmark and
embedding code into a less comfortable ecosystem. Python inverts both. A split
runtime is defensible but doubles the toolchain on a three-day budget, and toolchain
overhead is exactly what runs out. My recommendation is Node everywhere, accepting a
slightly clumsier benchmark, because the install line is on the README's first screen
and the benchmark is not.

**D2 — Infrastructure tooling.** CDK produces a better architecture diagram almost for
free and is pleasant for anything non-trivial; SAM deploys faster and has less to go
wrong. The deciding question is not elegance but whether you can redeploy reliably in
under ten minutes on day three under time pressure. Pick whichever you have actually
used before, and if that is neither, pick SAM.

**D3 — Dedupe threshold.** Publishing a swept curve is a credibility artifact and
costs perhaps two hours. Publishing a single untuned value and admitting it was not
tuned is honest and costs nothing. Both are respectable; the curve is better if day
three has slack, and it is the first thing to cut if it does not.

**D4 — Scope of the naive arm.** A more faithful naive arm, one that includes a real
local vector store rather than an in-memory approximation, makes the comparison
harder to dismiss but costs several hours. If the benchmark is the centrepiece, that
fidelity is where the hours belong. My recommendation is to spend them.
