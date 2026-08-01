# 09 — Distribution

The hackathon is one outcome. The repository and the content are the durable ones.
Both come free if the build is sequenced correctly, and both are lost if you treat the
submission as the finish line.

---

## 1. Repository layout

```
cortex/
  README.md                 first screen per 07 §7
  LICENSE                   MIT, set in repo settings so it shows in About
  THIRD-PARTY.md            dependency licences
  docs/
    architecture.md         diagram plus the flows from 04
    memory-model.md         public version of 03
    prior-art.md            the comparison table, competitors named
    verification-log.md     what was checked against a live cluster, and when
    limitations.md          written by you
  packages/
    core/                   the library
    cli/                    npx entry point
    mcp/                    the write-plane MCP server
  skills/
    cortex-memory/SKILL.md
  bench/
    fixtures/  cassettes/  results/
  infra/                    IaC
  demo/                     the SPA
```

`docs/verification-log.md` and `docs/limitations.md` are unusual for a hackathon repo
and that is exactly why they land. They read as engineering judgement.

## 2. What actually converts a visitor to a star

In descending order of effect:

1. A GIF above the fold showing the failure and the fix in under eight seconds.
2. A benchmark table with a number that is surprising.
3. A one-line install that genuinely works from an empty machine.
4. A thesis sentence that reframes something the reader already believed.
5. A named comparison to tools the reader respects, handled fairly.

Not on the list: architecture diagrams, feature lists, badges, roadmaps. Those keep
people who already decided; they do not decide anyone.

## 3. Launch sequence, after the submission

Do not launch before submitting. A public repository before the deadline invites
copies, and 2,500 people are looking for ideas.

- **Day 0** submission closes.
- **Day 1** repository polished, benchmark reproducible from a clean clone by someone
  who is not you. Test this on a borrowed machine.
- **Day 2** Hacker News Show HN, morning US Eastern. Title states the mechanism, not
  the product: *Show HN: Coordination layer that stops parallel coding agents from
  duplicating work.* First comment is your own, containing the methodology and the
  limitations. Commenters who find the limitations before you do will frame the
  thread; commenters who find them stated will discuss the mechanism.
- **Day 3** relevant subreddits and dev communities. Lead with the benchmark table.
- **Week 2** a written post covering how the arbitration transaction works, published
  wherever you write. Link the paper. Do not oversell.

Expected outcome, honestly calibrated: comparable open-source projects in this space
from funded companies with a Show HN sit around a hundred stars. Hundreds is a good
result; thousands would be an outlier. The value is the artifact and the evidence, not
the counter.

## 4. Content angles

Each is a separate piece; none requires work beyond what the build already produced.

**A — the failure.** Screen recording of the naive run. Five agents, one repo,
duplicate work climbing, a write disappearing. Hook plus immediate payoff, best under
twenty seconds. This is the strongest asset you will have and it costs nothing extra
because you record it for the benchmark anyway.

**B — the number.** The benchmark table as the hook. Problem, agitation, solution over
thirty to sixty seconds: parallel agents are normal now, most of their work is thrown
away, here is the measurement and here is what fixed it.

**C — the mechanism.** Longer form, anchored on the real story of discovering the
dual-write hole: the check passes against a stale index and the agent claims work that
is already done. A concrete failure narrative carries a technical explanation better
than a diagram.

**D — the landscape.** Where durable execution stops and coordination begins. This is
the piece that positions you as someone who understands the field rather than someone
who built a tool, and it is the one that developers with influence actually share.

Keep the same thesis sentence across all four. Repetition of one idea across formats
is what builds recognition; four different framings build none.

## 5. After the hackathon

Only if the repository shows real traction, and only then:

- A hosted control plane for teams: which agents may touch which resources, policy,
  audit. This is the commercial shape, and it is deliberately absent from the
  hackathon submission because it would dilute the message.
- Adapters for additional agent runtimes.
- A contribution to the CockroachDB skills repository, which is a relationship as much
  as a feature.

If traction does not appear, the correct move is to leave the repository as a finished
artifact rather than nurse it. A complete, well-documented, honestly benchmarked
project that is not maintained reads better than an abandoned roadmap.
