/**
 * THE BEHAVIOURAL PROBE — "is this feature in that tree" answered by running the app.
 *
 * `src/demo/attribution.ts` takes a `FeatureProbe` rather than deciding presence itself, and this
 * is the one every caller should use. It runs `bench/demo-app/acceptance.ts`'s check for the
 * ticket and reports what the check saw.
 *
 * **Why this is a module and not two lines inside attribution.** Because it was two lines inside
 * nothing for an afternoon, and the reason is worth writing down.
 *
 * The oracle is fenced: an agent that can read the checks it is graded against is fitting tests
 * rather than doing a ticket, and design §2 decision 10 already refused a tool loop. The first
 * version of that fence was a text scan over **all** of `src`, `scripts`, `bench` and
 * `infra/lambda` for any import of the oracle — broader than the rule it enforces, and it forbade
 * exactly the thing the oracle exists for. `scripts/gate-workload.mts` was left supplying a
 * text-exact probe and reporting `NOT EVALUATED` for attribution on precisely the runs where a
 * model authored the code, which is the only case a behavioural probe is needed for.
 *
 * The fence is now around **the prompt**: `test/acceptance.test.ts` asserts the oracle is not in
 * `APP_FILES`, not in the assembled document, not imported by `src/demo/author.ts` — the only
 * module that composes a prompt — and, the plank that actually holds, that no forty-character
 * window of the oracle's source appears in the prompt any ticket in the cut produces. That last
 * one was mutation-tested by leaking the oracle into `buildPrompt`, and it goes red.
 *
 * So everything downstream of the model may run the oracle freely, and should.
 *
 * **Presence is a verdict, not a boolean, and `error` is the load-bearing third value.** A tree
 * that throws is a lane that lost a whole file, which is a different fact from a lane whose code
 * answers wrongly — and `06` §6's rule, applied to a verdict rather than a rate, says the two must
 * not render the same. `attribution.ts` turns a throwing probe into `error` on its own, so this
 * module does not need to; what it must not do is convert one into `fail`.
 */
import { checkById } from '../../bench/demo-app/acceptance.js';

import type { FeatureProbe } from './attribution.js';

/**
 * The interlock checks, re-exported so callers reach the oracle through one seam.
 *
 * One import site rather than several is what makes the fence auditable: `test/acceptance.test.ts`
 * asserts the oracle is absent from the prompt, and a reader checking that claim should have one
 * place to look for who runs it and why.
 */
export { COMPOSITION_CHECKS, type CheckResult } from '../../bench/demo-app/acceptance.js';

/**
 * The probe for one ticket.
 *
 * The oracle's check ids **are** the workload's ticket ids — `I3`, `P2a`, `C3`, `R3` and the rest
 * — so there is no mapping table to drift. `checkById` throws for an id it does not know, which is
 * the right answer: a ticket carrying code and no check is a hole in the oracle, and a probe that
 * quietly returned "present" for it would certify work nobody verified.
 */
export function behaviouralProbe(taskId: string): FeatureProbe {
  const check = checkById(taskId);
  return (tree) => {
    const result = check.run(tree);
    return { verdict: result.verdict, observed: result.observed };
  };
}

/** Whether the oracle can decide this ticket at all, so a caller can say so rather than guess. */
export function hasBehaviouralCheck(taskId: string): boolean {
  try {
    checkById(taskId);
    return true;
  } catch {
    return false;
  }
}
