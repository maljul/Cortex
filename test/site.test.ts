/**
 * THE DEMO PAGE — spec/03-MEMORY-MODEL.md §8 invariant 8, spec/07 §4, spec/05 §5.
 *
 * Invariant 8 is "no credential field on any demo surface, under any name, including
 * commented out or feature-flagged off", and this page is the surface it was written
 * about. `07` §4 states the reasoning plainly: the hazard is not that a judge would supply
 * a credential, it is that once the field exists on a public page somebody eventually
 * pastes a live production key into it, and you own that.
 *
 * A rule like that regresses the day someone adds "just a debug field" — so it is checked
 * rather than trusted. The file is read as text, so a field that is present but hidden,
 * disabled, or sitting inside a comment fails exactly as loudly as a visible one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const page = readFileSync(
  fileURLToPath(new URL('../infra/site/index.html', import.meta.url)),
  'utf8',
);

function pageFunction(name: string, prelude = ''): (...args: unknown[]) => unknown {
  const match = page.match(
    new RegExp(`    function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n    \\}`),
  );
  if (!match) throw new Error(`page function ${name} not found`);

  const parameters = match[1]
    ?.split(',')
    .map((parameter) => parameter.trim())
    .filter(Boolean) ?? [];
  return new Function(...parameters, `${prelude}\n${match[2] ?? ''}`) as (
    ...args: unknown[]
  ) => unknown;
}

/**
 * The page's own one-line helpers, lifted out of the page rather than restated here.
 *
 * `headlineSentence` formats through them, so a test that could not see them would have to keep a
 * second copy of the formatting — and a second copy is how the assertion and the page start
 * disagreeing about what the page says.
 */
function pageHelpers(): string {
  const match = page.match(/\n( {4}const seconds = [^\n]*\n {4}const laneName = [^\n]*)\n/);
  if (!match) throw new Error('the page helpers `seconds` and `laneName` were not found');
  return match[1] ?? '';
}

/** A fleet event as it arrives on the wire, with only the fields the timeline reads. */
function event(
  agent: string,
  taskId: string,
  phase: string,
  at: number,
  detail: Record<string, unknown> = {},
): Record<string, unknown> {
  return { seq: at, arm: 'cortex', agent, taskId, phase, at, detail };
}

const TERMINAL_PHASES = [
  'patched',
  'blocked',
  'deduped',
  'spared',
  'abandoned',
  'contended',
  'overwritten',
];

type Row = { id: string; state: string; evidence: string[] };

/** The five interlocks exactly as the page declares them, so a test never invents a sixth. */
function pageInterlocks(): { id: string; needs: string[][]; measuredBy: string }[] {
  const source = page.match(/const INTERLOCKS = \[([\s\S]*?)\n {4}\];/)?.[1];
  if (!source) throw new Error('INTERLOCKS not found on the page');
  return new Function(`return [${source}]`)() as {
    id: string;
    needs: string[][];
    measuredBy: string;
  }[];
}

function step(taskId: string, agent: string, reported: string): Record<string, unknown> {
  return { taskId, agent, intentId: reported === 'deduped' ? null : `i-${taskId}`, reported };
}

/** Every ticket reported `done`, so a test can override only the ones it is about. */
function allDone(): Record<string, unknown>[] {
  return ['I3', 'P2a', 'P2b', 'P6a', 'P6b', 'C1', 'C2', 'C3', 'R3', 'A1', 'T11'].map((taskId) =>
    step(taskId, 'agent-1', 'done'),
  );
}

describe('the demo page accepts nothing from the visitor — invariant 8', () => {
  it.each(['<input', '<form', '<textarea', '<select', 'contenteditable'])(
    'contains no %s anywhere, including commented out',
    (element) => {
      expect(page.toLowerCase()).not.toContain(element);
    },
  );

  /**
   * Names, not just elements. A page that took a DSN from the query string or from
   * `localStorage` would pass the element check while doing the forbidden thing.
   */
  it.each([
    'password',
    'api_key',
    'apikey',
    'secret',
    'bearer',
    'connection string',
    'localstorage',
    'prompt(',
  ])('never mentions %s', (token) => {
    expect(page.toLowerCase()).not.toContain(token);
  });

  it('names a DSN only when saying it never accepts one', () => {
    // `dsn` may legitimately appear in the header's explanation of the rule. What must not
    // appear is a field, a parameter or a storage key — covered by the checks above.
    const mentions = page.toLowerCase().split('dsn').length - 1;
    expect(mentions).toBeLessThanOrEqual(1);
  });
});

describe('the page cannot be deployed pointing at a stale stack', () => {
  /**
   * `scripts/deploy-site.mts` injects `window.CORTEX_API_URL` and `window.CORTEX_STREAM_URL`
   * at upload time, because both are CloudFormation outputs. A hardcoded hostname would
   * survive a stack replacement and serve a page talking to something that no longer
   * exists — which presents as "the demo is broken" rather than as a deploy mistake.
   */
  it('reads both endpoints from the injected globals', () => {
    expect(page).toContain('window.CORTEX_API_URL');
    expect(page).toContain('window.CORTEX_STREAM_URL');
  });

  it.each(['execute-api', 'cloudfront.net', 'amazonaws.com'])(
    'hardcodes no %s hostname',
    (host) => {
      expect(page).not.toContain(host);
    },
  );
});

describe('the page says what it is, per `07` §4', () => {
  /**
   * §4 requires an always-visible mode line. It is rendered from `GET /demo/state`'s `mode`
   * block rather than written into the markup, so the page cannot claim a liveness the
   * backend is not reporting — but the element has to exist for that to land anywhere.
   */
  it('carries a mode line, and fills it from the backend', () => {
    expect(page).toContain('id="mode"');
    expect(page).toContain('state.mode.name');
  });

  /** `04` §5 invariant 1: no rung may present an error page. */
  it('handles an unreachable backend without an error page', () => {
    expect(page).toContain('backend unreachable');
    expect(page.toLowerCase()).not.toContain('stack trace');
  });
});

describe('the fleet redesign makes the coordination visible — U25', () => {
  /**
   * Break caught: replacing the page with a generic hero or removing one of the comparison
   * surfaces. The two arms, the task journey, the event graph and the produced applications are
   * the four different views a cold reader needs to connect cause to effect.
   */
  it.each([
    'id="comparison"',
    'id="journey"',
    'id="judge-guide"',
    'id="timeline"',
    'id="gantt"',
    'id="interlocks"',
    'id="flow-graphs"',
    'id="task-board"',
    'id="results"',
    'id="benchmark"',
    'id="production"',
  ])('keeps the %s section in the single-page argument', (landmark) => {
    expect(page).toContain(landmark);
  });

  /** Break caught: a page that runs the old four-beat branch instead of the real fleet. */
  it('starts the asynchronous two-arm fleet from the one primary action', () => {
    expect(page.match(/id="run-demo"/g)).toHaveLength(1);
    expect(page).toContain("mode: 'fleet'");
    expect(page).toContain('naive: session.scopes.naive');
    expect(page).toContain("message.type === 'fleet'");
    expect(page).toContain("message.type === 'run'");
  });

  /**
   * Break caught: turning runner activity into a fake database row, or dropping committed rows
   * from the visual explanation. Design §5.3 says the two sources have different authority.
   */
  it('labels committed rows separately from timestamped fleet activity', () => {
    expect(page).toContain("message.type === 'change'");
    expect(page).toContain('COMMITTED ROW');
    expect(page).toContain('FLEET EVENT');
  });

  /**
   * Break caught: rendering the prewritten screenshots instead of the two file trees the agents
   * actually produced. Exactly two sandboxed frames make the result comparable without a toggle.
   */
  it('runs both produced applications in networkless sandboxed frames', () => {
    expect(page.match(/<iframe\b/g)).toHaveLength(2);
    expect(page.match(/sandbox="allow-scripts"/g)).toHaveLength(2);
    expect(page).toContain("cortexFrame.srcdoc = assembleApp(cortexState.files)");
    expect(page).toContain("naiveFrame.srcdoc = assembleApp(naiveState.files)");
  });

  /**
   * Break caught: always accusing the isolated arm of the designed four defects even when the
   * database produced a different race winner. The result labels must be derived from that arm's
   * returned tree, for the same reason the meter is derived from readback.
   */
  it('derives every result verdict from the returned file trees', () => {
    expect(page).toContain('const shippingWrong =');
    expect(page).toContain('const duplicateConfirmation =');
    expect(page).toContain('const oversellWrong =');
    expect(page).toContain('const missingSharedFile =');
  });

  /**
   * Break caught: treating an absent beat as a broken UI, inventing a zero, or losing the failed
   * run after some real events already arrived.
   */
  it('has deliberate states for an unobserved beat, unmeasured value and partial failure', () => {
    expect(page).toContain('NOT OBSERVED THIS RUN');
    expect(page).toContain('TBD');
    expect(page).toContain('Everything above this line happened before the run stopped.');
  });

  /**
   * Break caught: showing N/A before a run, or showing claim latency as unmeasured when that arm
   * has no claim transaction. Those are different claims and a zero is different from both.
   */
  it('distinguishes measured zero, not applicable and not measured in the meter logic', () => {
    expect(page).toContain("if (!hasRun) return { value: 'TBD'");
    expect(page).toContain('if (value === null && TBD_WHEN_NULL.indexOf(key) >= 0)');
    expect(page).toContain("if (value === null) return { value: 'N/A'");
    expect(page).toContain("Number(value) === 0 ? 'metric-zero'");
  });

  /**
   * Break caught: a REPLAY run's token counts rendering as N/A or as a measured 0. `06` §6: a run
   * that made no model call did not measure zero spend, it measured nothing — and `claimP50Ms`
   * stays on the other side of that line, because an arm with no claim transaction genuinely has
   * no such latency to report.
   */
  it('puts every unmeasured token count on the TBD side of the line, and claim latency on the other', () => {
    const list = page.match(/const TBD_WHEN_NULL = \[([^\]]*)\]/)?.[1] ?? '';
    expect(list).toContain("'wastedTokens'");
    expect(list).toContain("'modelInputTokens'");
    expect(list).toContain("'modelOutputTokens'");
    expect(list).not.toContain('claimP50Ms');
  });

  /**
   * Break caught: shipping a static mockup that cannot demonstrate itself when opened directly.
   * The fixture path is visibly labelled and cannot be mistaken for the deployed live database.
   */
  it('provides a clearly labelled local preview without weakening the deployed live path', () => {
    expect(page).toContain('SIMULATED UI PREVIEW');
    expect(page).toContain('runPreview');
    expect(page).toContain('backend unreachable');
  });

  /**
   * Break caught: replacing the mechanism explanation with an abstract graph that gives a judge
   * no way to connect a fleet event to ordinary development work.
   */
  it('shows the system as a concrete development workflow driven by fleet events', () => {
    expect(page).toContain('id="development-workflow"');
    expect(page).toContain('const DEVELOPMENT_PHASES =');
    expect(page).toContain('function renderDevelopmentWorkflow()');
    expect(page).toContain('renderDevelopmentWorkflow();');
    expect(page).toContain("task.module");
    expect(page).toContain("task.statement");
  });

  /**
   * Break caught: restoring the anonymous center circle from V53. The coordination point must be
   * the supplied CORTEX mark so the visual says which component owns the transaction boundary.
   */
  it('uses the CORTEX brain as the central workflow node', () => {
    expect(page).toContain('id="cortex-hub-logo"');
    expect(page).toContain('class="workflow-logo"');
    expect(page).toContain('aria-label="CORTEX coordination hub"');
  });

  /**
   * Break caught: simplifying the workload until both arms can succeed by accident. These are the
   * three independent ways the committed run forces agents to coordinate across task wording,
   * files and earlier decisions.
   */
  it('makes the workload hazards visible before the result', () => {
    expect(page).toContain('id="workload-risks"');
    expect(page).toContain('data-risk="semantic-duplicates"');
    expect(page).toContain('data-risk="shared-file"');
    expect(page).toContain('data-risk="decision-dependency"');
  });

  /**
   * Break caught: two application panes with no computed verdict, which forces the judge to infer
   * whether the systems actually behaved differently. The summary consumes the terminal meters
   * and the returned trees after both exist.
   */
  it('derives a direct two-arm verdict after the final state is loaded', () => {
    expect(page).toContain('id="outcome-comparison"');
    expect(page).toContain('function renderOutcomeComparison(arms)');
    expect(page).toContain('renderOutcomeComparison(message.arms || []);');
    expect(page).toContain('state.states.naive.files');
    expect(page).toContain('state.states.cortex.files');
  });

  /**
   * Break caught: subscribing only to the CORTEX scope. The runner deliberately broadcasts its
   * own messages to both scopes, but CockroachDB changefeed rows are tenant-scoped and therefore
   * require one connection per arm. The secondary connection must not duplicate fleet or terminal
   * messages that the primary connection already receives.
   */
  it('subscribes to both scopes while accepting run messages only from the primary stream', () => {
    const streamTargets = pageFunction('streamTargets');
    expect(streamTargets({ cortex: 'scope-cortex', naive: 'scope-naive' })).toEqual([
      { sessionId: 'scope-cortex', source: 'primary' },
      { sessionId: 'scope-naive', source: 'changes' },
    ]);

    const acceptsSocketMessage = pageFunction('acceptsSocketMessage');
    expect(acceptsSocketMessage('primary', { type: 'fleet' })).toBe(true);
    expect(acceptsSocketMessage('primary', { type: 'run' })).toBe(true);
    expect(acceptsSocketMessage('primary', { type: 'change' })).toBe(true);
    expect(acceptsSocketMessage('changes', { type: 'change' })).toBe(true);
    expect(acceptsSocketMessage('changes', { type: 'fleet' })).toBe(false);
    expect(acceptsSocketMessage('changes', { type: 'run' })).toBe(false);

    expect(page).toContain('await openSockets(state.session.scopes)');
  });
});

describe('the fleet redesign is self-contained and accessible', () => {
  /** Break caught: an asset or dependency that a strict deployment policy refuses to load. */
  it('makes no external asset request and draws the supplied brain mark inline', () => {
    expect(page).toContain('<svg');
    expect(page).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(page).not.toMatch(/<link[^>]+\bhref=/i);
    expect(page).not.toMatch(/<img[^>]+\bsrc=/i);
  });

  /** Break caught: motion becoming content, or running for a visitor who reduced it. */
  it('uses observer-driven reveals and collapses them under reduced motion', () => {
    expect(page).toContain('IntersectionObserver');
    expect(page).toContain('prefers-reduced-motion: reduce');
    expect(page).toContain('scroll-behavior: auto');
  });

  /** Break caught: the supplied design palette drifting into a generic blue or purple theme. */
  it.each(['#131820', '#1A2029', '#252C36', '#E8EAED', '#98A0AC', '#5CBCAA']) (
    'keeps the brand token %s',
    (token) => {
      expect(page).toContain(token);
    },
  );

  /**
   * Break caught: a timeline that grows its bars for a visitor who asked for no motion. The bars
   * are data — a reader who cannot see them settle cannot read the run.
   */
  it('stops the timeline animating under reduced motion', () => {
    const reduced = page.slice(page.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.gantt-bar { animation: none;');
  });
});

/**
 * THE CONCURRENCY TIMELINE — U27.
 *
 * The owner's complaint was that the page never showed the agents working *together*, and the
 * runner has always run them concurrently inside a wave. These tests are about the two ways that
 * could be made to look true without being true: a bar drawn from something other than a streamed
 * timestamp, and a comparison against a run that never happened.
 */
describe('the timeline is built from streamed timestamps and nothing else', () => {
  const buildSegments = pageFunction('buildSegments') as (
    events: unknown[],
    terminal: string[],
  ) => { agent: string; taskId: string; start: number; end: number; outcome: string }[];

  /**
   * Break caught: collapsing a blocked agent's two attempts into one bar, which draws a solid
   * block over an interval in which that agent held nothing and did nothing. `03` §5's whole point
   * is that a blocked agent loses fast and comes back — one bar would hide the losing.
   */
  it('gives a blocked agent a second bar when it comes back', () => {
    const segments = buildSegments(
      [
        event('agent-2', 'C2', 'started', 0),
        event('agent-2', 'C2', 'claiming', 100),
        event('agent-2', 'C2', 'blocked', 200, { contested: [{ holder: 'agent-1' }] }),
        event('agent-2', 'C2', 'started', 900),
        event('agent-2', 'C2', 'reading', 1000),
        event('agent-2', 'C2', 'patched', 1800),
      ],
      TERMINAL_PHASES,
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ outcome: 'blocked', start: 0, end: 200 });
    expect(segments[1]).toMatchObject({ outcome: 'patched', start: 900, end: 1800 });
  });

  /** Break caught: a deduped bar drawn to the end of the run, which is time nobody spent. */
  it('stops a deduped bar at the moment the cluster refused it', () => {
    const segments = buildSegments(
      [
        event('agent-3', 'P2b', 'started', 0),
        event('agent-3', 'P2b', 'claiming', 120),
        event('agent-3', 'P2b', 'deduped', 300, { of: 'intent-p2a', distance: 0.2058 }),
        event('agent-1', 'I3', 'started', 0),
        event('agent-1', 'I3', 'patched', 4000),
      ],
      TERMINAL_PHASES,
    );

    const deduped = segments.filter((segment) => segment.outcome === 'deduped');
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.end).toBe(300);
  });

  /**
   * Break caught: extrapolating an unfinished bar to the run's edge while the run is still going.
   * A bar during a live run means "this is how far it has got", never "this is how long it took".
   */
  it('draws a segment that has not ended only as far as its last event', () => {
    const segments = buildSegments(
      [event('agent-5', 'A1', 'started', 0), event('agent-5', 'A1', 'reading', 640)],
      TERMINAL_PHASES,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ outcome: 'open', start: 0, end: 640 });
  });
});

describe('the collision bands count what the file-collisions figure counts', () => {
  const overlapBands = pageFunction('overlapBands') as (
    spans: unknown[],
  ) => { file: string; agents: string[]; from: number; to: number }[];

  const span = (agent: string, taskId: string, file: string, from: number, to: number) => ({
    agent,
    taskId,
    file,
    startLine: 1,
    endLine: 2,
    startedMs: from,
    endedMs: to,
  });

  /**
   * Break caught: counting hunk pairs instead of agent pairs. `src/demo/conflicts.ts` counts
   * distinct agent pairs per file because a lost write costs one file once however many hunks were
   * in it — a picture on a different unit from the number beside it is two facts wearing one name.
   */
  it('counts distinct agent pairs per file, not hunk pairs', () => {
    const bands = overlapBands([
      span('agent-1', 'C1', 'orders/repository.js', 100, 900),
      span('agent-1', 'C1', 'orders/repository.js', 100, 900),
      span('agent-2', 'C2', 'orders/repository.js', 200, 1000),
      span('agent-3', 'C3', 'orders/repository.js', 300, 1100),
    ]);

    expect(bands).toHaveLength(3);
    expect(bands.map((band) => band.agents.join('+'))).toEqual([
      'agent-1+agent-2',
      'agent-1+agent-3',
      'agent-2+agent-3',
    ]);
  });

  /** Break caught: an agent counted as colliding with itself, or across two different files. */
  it('never reports one agent, or two files, as a collision', () => {
    expect(
      overlapBands([
        span('agent-1', 'C1', 'orders/repository.js', 0, 900),
        span('agent-1', 'R3', 'orders/repository.js', 100, 800),
        span('agent-2', 'C2', 'orders/list.js', 100, 800),
      ]),
    ).toEqual([]);
  });

  /** Break caught: windows that merely exist counted as windows that overlapped. */
  it('reports nothing when the windows do not meet, and the intersection when they do', () => {
    expect(
      overlapBands([
        span('agent-1', 'C1', 'orders/repository.js', 0, 400),
        span('agent-2', 'C2', 'orders/repository.js', 500, 900),
      ]),
    ).toEqual([]);

    const [band] = overlapBands([
      span('agent-1', 'C1', 'orders/repository.js', 0, 600),
      span('agent-2', 'C2', 'orders/repository.js', 500, 900),
    ]);
    expect(band).toMatchObject({ from: 500, to: 600 });
  });
});

describe('no figure on the timeline describes a run that did not happen', () => {
  const armTiming = pageFunction('armTiming') as (
    segments: unknown[],
    events: unknown[],
  ) => Record<string, number | null>;
  const headlineSentence = pageFunction('headlineSentence', pageHelpers()) as (
    model: unknown[],
    clause: string,
  ) => string;

  /**
   * Break caught: presenting concurrency as a speed-up against a serial baseline. The run never
   * performs one, so the only honest ratio is between two things it did measure — the sum of the
   * agents' own elapsed times, and the lane's wall clock.
   */
  it('derives concurrency from two measured quantities and nothing else', () => {
    const timing = armTiming(
      [
        { agent: 'agent-1', taskId: 'I3', start: 0, end: 1000 },
        { agent: 'agent-2', taskId: 'P2a', start: 0, end: 1000 },
        { agent: 'agent-3', taskId: 'P2b', start: 0, end: 1000 },
      ],
      [{ at: 0 }, { at: 1000 }],
    );

    expect(timing).toMatchObject({ wallMs: 1000, agentMs: 3000, concurrency: 3, attempts: 3 });
  });

  /** Break caught: dividing by a wall clock of zero and rendering `Infinity` as a measurement. */
  it('reports concurrency as unmeasured rather than infinite before anything elapses', () => {
    expect(armTiming([], []).concurrency).toBeNull();
  });

  /** Break caught: a comparative clause that is not a subtraction of two measured figures. */
  it('compares the two lanes only by subtracting their measured agent time', () => {
    const model = [
      { arm: 'naive', timing: { wallMs: 3000, agentMs: 9000, concurrency: 3 } },
      { arm: 'cortex', timing: { wallMs: 2000, agentMs: 4000, concurrency: 2 } },
    ];
    const sentence = headlineSentence(model, 'CLAUSE');

    expect(sentence).toContain('The isolated lane spent 9.00s of agent time inside 3.00s');
    expect(sentence).toContain('The arbitrated lane spent 4.00s of agent time inside 2.00s');
    expect(sentence).toContain('5.00s less agent time in the arbitrated lane');
    expect(sentence).toContain('CLAUSE');
    expect(sentence).not.toMatch(/serial|one at a time|would have/i);
  });
});

/**
 * PER-INTERLOCK HONESTY — the reason a varying outcome reads as evidence rather than as an excuse.
 *
 * Once a model authors the code, an interlock can fail to fire because the uninformed agent
 * happened to get it right. That is a result. It is only a result if the page can tell it apart
 * from "nobody measured" and from "the tickets never ran", so those are three states and not one.
 */
describe('an interlock reports what this run is entitled to say about it', () => {
  const interlockRows = pageFunction('interlockRows') as (
    arms: unknown[],
    interlocks: unknown[],
  ) => Row[];
  const interlocks = pageInterlocks();

  const arm = (
    name: string,
    verdicts: Record<string, string>,
    steps: Record<string, unknown>[] = allDone(),
    meter: Record<string, number> = { agentsSpared: 0, deadEndsWalked: 1 },
  ) => ({
    arm: name,
    steps,
    meter,
    acceptance: Object.entries(verdicts).map(([id, verdict]) => ({
      id,
      verdict,
      observed: `${name} observed ${id}`,
    })),
  });

  const four = (verdict: string): Record<string, string> => ({
    'interlock-1': verdict,
    'interlock-2': verdict,
    'interlock-3': verdict,
    'interlock-4': verdict,
  });

  const stateOf = (rows: Row[], id: string) => rows.filter((row) => row.id === id)[0]?.state;

  /** Break caught: an unreported interlock rendering as a measured zero. */
  it('says TBD when the run published no acceptance result at all', () => {
    const rows = interlockRows(
      [
        { arm: 'naive', steps: allDone(), meter: {} },
        { arm: 'cortex', steps: allDone(), meter: {} },
      ],
      interlocks,
    );
    expect(rows.filter((row) => row.state === 'not-measured')).toHaveLength(4);
  });

  /** Break caught: the page accusing the isolated lane of a defect the run did not observe. */
  it('separates a defect that occurred from one that did not, on the same evidence', () => {
    const occurred = interlockRows([arm('naive', four('fail')), arm('cortex', four('pass'))], interlocks);
    expect(stateOf(occurred, 'interlock-1')).toBe('occurred');
    expect(occurred[0]?.evidence).toEqual([
      'isolated lane answered: naive observed interlock-1',
      'arbitrated lane answered: cortex observed interlock-1',
    ]);

    const quiet = interlockRows([arm('naive', four('pass')), arm('cortex', four('pass'))], interlocks);
    expect(stateOf(quiet, 'interlock-4')).toBe('did-not-occur');
    expect(quiet[3]?.evidence).toHaveLength(2);
  });

  /** Break caught: a tree that threw reported as a tree that answered wrongly. */
  it('keeps an unevaluatable tree distinct from a wrong answer', () => {
    const rows = interlockRows(
      [arm('naive', { ...four('fail'), 'interlock-3': 'error' }), arm('cortex', four('pass'))],
      interlocks,
    );
    expect(stateOf(rows, 'interlock-3')).toBe('not-evaluated');
  });

  /**
   * Break caught: an interlock whose tickets never reached the work reported as "did not occur",
   * which claims a measurement nobody took.
   */
  it('says the conditions did not arise when a ticket it needs never ran', () => {
    const contended = allDone().map((one) =>
      one['taskId'] === 'C3' ? step('C3', 'agent-3', 'contended') : one,
    );
    const rows = interlockRows(
      [arm('naive', four('pass'), contended), arm('cortex', four('pass'))],
      interlocks,
    );
    expect(stateOf(rows, 'interlock-3')).toBe('no-conditions');
    // A group is satisfied by either of its spellings: interlock 4 needs a confirmation, and
    // one half of the dedupe pair delivering it is the pair working, not the ticket failing.
    expect(stateOf(rows, 'interlock-4')).toBe('did-not-occur');
  });

  /** Break caught: hiding a run in which arbitration was the lane that got something wrong. */
  it('reports an inverted run straight rather than suppressing it', () => {
    const rows = interlockRows(
      [arm('naive', four('pass')), arm('cortex', { ...four('pass'), 'interlock-2': 'fail' })],
      interlocks,
    );
    expect(stateOf(rows, 'interlock-2')).toBe('inverted');
  });

  /**
   * Break caught: inventing an application check for interlock 5. A1 and T11 change no code, so
   * both lanes return identical trees and no question asked of one could separate them — it is the
   * meter or nothing, and `bench/demo-app/acceptance.ts` says so in its own header.
   */
  it('decides interlock 5 from the meter, because no returned tree can decide it', () => {
    const fifth = interlocks.filter((one) => one.id === 'interlock-5')[0];
    expect(fifth?.measuredBy).toBe('meter');

    const observed = interlockRows(
      [
        arm('naive', four('fail'), allDone(), { agentsSpared: 0, deadEndsWalked: 2 }),
        arm('cortex', four('pass'), allDone(), { agentsSpared: 1, deadEndsWalked: 1 }),
      ],
      interlocks,
    );
    expect(stateOf(observed, 'interlock-5')).toBe('occurred');

    const nobodySpared = interlockRows(
      [
        arm('naive', four('fail'), allDone(), { agentsSpared: 0, deadEndsWalked: 1 }),
        arm('cortex', four('pass'), allDone(), { agentsSpared: 0, deadEndsWalked: 1 }),
      ],
      interlocks,
    );
    expect(stateOf(nobodySpared, 'interlock-5')).toBe('did-not-occur');
  });

  /** Break caught: the oracle's assertions being copied onto a public page an agent could read. */
  it('carries the acceptance titles but none of the checks that decide them', () => {
    expect(page).toContain('the confirmation banner appears exactly once');
    expect(page).not.toContain('SKU-COFFEE');
    expect(page).not.toContain('runChecks');
    expect(page).not.toContain('COMPOSITION_CHECKS');
  });
});

/**
 * `07` §4's mode line, which inverts the moment a model authors a hunk.
 *
 * The page used to append a fixed sentence saying the patches were authored and reviewed. That was
 * true only while no model wrote any of them; after `src/demo/author.ts` it is the same rule broken
 * in the other direction, which is why the claim is now made from the run's own records.
 */
describe('the mode line states who wrote the code, per run', () => {
  const authorshipSummary = pageFunction('authorshipSummary') as (
    arms: unknown[],
  ) => Record<string, number | boolean>;

  /** Break caught: the old fixed sentence surviving somewhere in the page. */
  it('makes no standing claim about authorship anywhere in the markup', () => {
    expect(page).not.toContain('authored and reviewed');
    expect(page).toContain('function authorshipLine()');
    expect(page).toContain('MODEL-AUTHORED THIS RUN');
    expect(page).toContain('REPLAYED THIS RUN');
  });

  /**
   * Break caught: a run that published no authorship record rendering as "no model ran". Those are
   * different claims, and only one of them is something the page was told.
   */
  it('reports an unreported authorship as unknown rather than as replay', () => {
    const summary = authorshipSummary([
      { arm: 'naive', meter: {} },
      { arm: 'cortex', meter: {} },
    ]);
    expect(summary['known']).toBe(false);
    expect(page).toContain('Code authorship: TBD');
  });

  /**
   * Break caught: counting a fallback as a model authorship, which overstates what a model did.
   * `runArm` publishes the three counts on the meter and they partition every hunk that landed,
   * so the page can say "the model wrote 9 of 13 hunks" instead of implying it wrote them all.
   */
  it('prefers the meter’s hunk counts, which partition every hunk that landed', () => {
    const summary = authorshipSummary([
      {
        arm: 'naive',
        meter: {
          hunksAuthoredByModel: 6,
          hunksFallenBack: 2,
          hunksReplayed: 1,
          modelInputTokens: 1200,
          modelOutputTokens: 150,
        },
      },
      {
        arm: 'cortex',
        meter: {
          hunksAuthoredByModel: 3,
          hunksFallenBack: 1,
          hunksReplayed: 0,
          modelInputTokens: 800,
          modelOutputTokens: 90,
        },
      },
    ]);

    expect(summary).toMatchObject({
      known: true,
      unit: 'hunk',
      model: 9,
      fallback: 3,
      committed: 1,
      inputTokens: 2000,
      outputTokens: 240,
    });
  });

  /**
   * Break caught: summing a REPLAY run's zero token counts into a `0` that reads as a measurement
   * of nothing spent. Nobody called a model, so nobody measured — `06` §6's line.
   */
  it('keeps an unmeasured token count null rather than summing it to zero', () => {
    const summary = authorshipSummary([
      {
        arm: 'naive',
        meter: {
          hunksAuthoredByModel: 0,
          hunksFallenBack: 0,
          hunksReplayed: 7,
          modelInputTokens: null,
          modelOutputTokens: null,
        },
      },
      {
        arm: 'cortex',
        meter: {
          hunksAuthoredByModel: 0,
          hunksFallenBack: 0,
          hunksReplayed: 6,
          modelInputTokens: null,
          modelOutputTokens: null,
        },
      },
    ]);

    expect(summary).toMatchObject({ known: true, model: 0, committed: 13, inputTokens: null });
    expect(summary['outputTokens']).toBeNull();
  });

  /**
   * Break caught: dropping the per-ticket records a run may publish instead of the meter counts,
   * and silently reporting "authorship TBD" for a run that did say who wrote the code. The unit
   * changes with the shape and the sentence has to change with it.
   */
  it('falls back to per-ticket records, and says so by changing the unit', () => {
    const summary = authorshipSummary([
      {
        arm: 'cortex',
        meter: {},
        authorings: [
          { taskId: 'I3', source: 'model', inputTokens: 100, outputTokens: 10 },
          { taskId: 'C1', source: 'fallback', inputTokens: 200, outputTokens: 20 },
        ],
      },
      {
        arm: 'naive',
        meter: {},
        authorings: [{ taskId: 'I3', source: 'committed', inputTokens: 0, outputTokens: 0 }],
      },
    ]);

    expect(summary).toMatchObject({
      known: true,
      unit: 'ticket',
      model: 1,
      fallback: 1,
      committed: 1,
      inputTokens: 300,
      outputTokens: 30,
    });
  });

  /**
   * Break caught: the mode line implying the coordination is replayed when the code is. Whichever
   * way authorship falls, the database behaviour is live and the line must keep saying so.
   */
  it('says the database, arbitration, races and stream are live in both modes', () => {
    expect(page).toContain('Database behaviour, arbitration, the races and the change stream are live in both modes');
    expect(page).toContain('Database behaviour, arbitration, the races and the change stream were live, exactly as in replay');
  });

  /**
   * Break caught: the page telling a reader that outcomes vary only after one has varied, which
   * reads as an excuse. It has to be a prediction, so it sits above the button.
   */
  it('predicts the variance above the run button rather than explaining it afterwards', () => {
    const prediction = page.indexOf('id="run-prediction"');
    const results = page.indexOf('id="results"');
    expect(prediction).toBeGreaterThan(-1);
    expect(prediction).toBeLessThan(page.indexOf('id="comparison"'));
    expect(prediction).toBeLessThan(results);
    expect(page).toContain('No two runs of this page are the same');
  });
});

/**
 * THE LIVE AUTHORISATION.
 *
 * Invariant 8 forbids a credential field on this surface, and there is none: the value is not
 * asked for, it is carried in the URL an operator constructs. What has to hold anyway is that it
 * goes to the API and nowhere else — a token echoed into the DOM is in every screenshot of the
 * page for ever.
 */
describe('the LIVE authorisation reaches the API and nothing else', () => {
  const sinks = /textContent|innerHTML|innerText|append|prepend|replaceChildren|setAttribute|dataset|srcdoc|title\s*=|console\.|value\s*=|alert|document\.write/;

  /**
   * Break caught: sending it where the route does not look. `src/demo/api.ts` reads the
   * capability from `request.query['live']` on both routes, and a body field would be silently
   * ignored — which presents as "LIVE never works" rather than as a wiring mistake.
   */
  it('reads it from the query string and presents it on the query string', () => {
    expect(page).toContain("new URLSearchParams(window.location.search).get('live')");
    expect(page).toContain("liveGrant ? '?live=' + encodeURIComponent(liveGrant) : ''");
    expect(page).toContain("(liveGrant ? '&live=' + encodeURIComponent(liveGrant) : '')");
  });

  /**
   * Break caught: the page composing its own REPLAY notice. `PUBLIC_REPLAY_REASON` names no quota
   * and no capability on purpose — design §7.1 requires the page to be indistinguishable from the
   * public one for a caller without the token, and locally worded copy is one edit from leaking
   * that a gate exists.
   */
  it('renders the route’s own reasoning sentence rather than restating it', () => {
    expect(page).toContain('function reasoningLine()');
    expect(page).toContain('state.reasoning = result.reasoning || null');
    expect(page).toContain('reasoning.reason');
    expect(page).toContain('LIVE REASONING AUTHORISED FOR THIS RUN');
  });

  /**
   * Break caught: a run the route declined to start leaving the page waiting for events that
   * never come. `04` §5's rung 3 answers 200 with `started: false` and its reason, and a page
   * that only checked `response.ok` would sit on it for ever.
   */
  it('reports a run the backend declined to start, rather than waiting for it', () => {
    expect(page).toContain('if (result.started === false)');
    expect(page).toContain('if (accepted.started === false)');
  });

  /** Break caught: any line that touches the value also touching a DOM sink or the console. */
  it('never lets a line that touches it reach the DOM or a log', () => {
    const lines = page
      .split('\n')
      .filter((line) => /readLiveGrant|liveGrant|HAS_LIVE_GRANT/.test(line));

    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line, `a line touching the LIVE grant reaches a sink: ${line.trim()}`).not.toMatch(
        sinks,
      );
    }
  });

  /** Break caught: the field being asked for on the page instead of supplied in the URL. */
  it.each(['credential', 'passphrase', 'access key', 'private key', 'username', 'autocomplete'])(
    'never mentions %s either',
    (token) => {
      expect(page.toLowerCase()).not.toContain(token);
    },
  );
});
