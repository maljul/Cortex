/**
 * THE ACCEPTANCE ORACLE — did the work actually work, decided by running it.
 *
 * ## Why this exists
 *
 * Until now an interlock was detected by **looking for a string**: `src/demo/attribution.ts`
 * asks whether a tree's file contains a committed patch's replacement text, and
 * `scripts/gate-workload.mts` asks the same question of four fixed markers. That is exact and
 * cheap while every patch is committed. The moment an agent *authors* the code, none of that
 * text is there, every marker reads absent, and the page reports five interlocks and a fleet of
 * lost writes that never happened — silently, with the suite green.
 *
 * So the interlocks have to be decided **behaviourally**: assemble the tree, run it, and ask it
 * questions a judge could ask by clicking. A check here never inspects source; it calls the
 * functions the app calls and reads what comes back.
 *
 * ## Two sets, and the difference between them is the whole argument
 *
 * - `TICKET_CHECKS` — *did this agent's change work on its own?* One per ticket that carries
 *   code, and each one depends on that ticket alone. Run against a tree carrying only that
 *   ticket's work they all pass, **in both lanes** — which is design §3.1's sharpest claim
 *   made executable: neither agent wrote a bug.
 * - `COMPOSITION_CHECKS` — *does the assembled app behave?* One per interlock. These are the
 *   ones the naive lane fails while every ticket check still passes, and that gap is the demo.
 *
 * ## Never a bare boolean
 *
 * Every check returns `{ id, verdict, observed }`. `observed` is the string the page renders as
 * evidence — "shipping renders £0.03; the tariff for 0.75kg is 3.37" is a defect a reader can
 * check. A boolean is an assertion the reader has to take on trust, and `02` A7 does not allow
 * the page to ask for trust. `error` is a third verdict rather than a false, because a tree that
 * *throws* (a lane that lost a whole file) is a different fact from a tree that answers wrongly.
 *
 * ## THIS FILE IS WITHHELD FROM THE AGENTS
 *
 * It is not in `APP_FILES`, so nothing that assembles a corpus for an agent to read can reach
 * it, and `test/acceptance.test.ts` fails if that changes or if any non-test module ever refers
 * to it. That is not tidiness. A corpus whose test suite the agent can read is a specification
 * it optimises against, and the question the demo is asking silently turns from *"did the agent
 * do the work"* into *"did the agent make the tests pass"* — which is precisely the result that
 * would not survive a judge asking how it was scored.
 *
 * Interlock 5 has **no check here and cannot have one**: A1 and T11 patch nothing, so both
 * lanes' trees are byte-identical and every behavioural question has the same answer in each.
 * What differs is whether a second agent spent its budget rediscovering a dead end, and that
 * shows in the journey and the token meter or nowhere.
 */
import { evaluate, type App } from '../../src/demo/evaluate.js';
import type { FileTree } from '../../src/demo/patches.js';

export type Verdict = 'pass' | 'fail' | 'error';

/** One answered question. `observed` is evidence, not a restatement of the verdict. */
export interface CheckResult {
  id: string;
  verdict: Verdict;
  observed: string;
}

export interface AcceptanceCheck {
  /** Stable id — the ticket it belongs to, or the interlock it decides. */
  id: string;
  /** One line, in the terms a reader of the page would use. */
  title: string;
  run(tree: FileTree): CheckResult;
}

/** What a check body answers. The `observed` string is required even when it passes. */
interface Observation {
  pass: boolean;
  observed: string;
}

interface OrderLine {
  sku: string;
  quantity: number;
  price: number;
}

interface OrderRecord {
  id: string;
  customer: string;
  status: string;
  placedAt: string;
  lines: OrderLine[];
}

interface PlaceResult {
  ok: boolean;
  reason?: string;
  order?: OrderRecord;
}

interface HistoryEntry {
  status: string;
  at: string;
}

/**
 * The order every check that needs a real one uses, read out of the corpus rather than written
 * here. Three filter coffees: 0.75kg billable, and the only order the shipping tariff has been
 * hand-checked against.
 */
const SUBJECT_ORDER = 'A-1001';

/** The SKU with three units on the shelf and nothing reserved against it. */
const SCARCE_SKU = 'SKU-COFFEE';

function fn<T>(app: App, name: string): T {
  return app[name] as unknown as T;
}

function order(app: App, id: string): OrderRecord {
  const found = fn<(id: string) => OrderRecord | null>(app, 'findOrder')(id);
  if (found === null) throw new Error(`the corpus no longer contains ${id}`);
  return found;
}

function place(app: App, sku: string, quantity: number): PlaceResult {
  return fn<(form: { customer: string; sku: string; quantity: number }) => PlaceResult>(
    app,
    'submitNewOrder',
  )({ customer: 'Walk-in', sku, quantity });
}

/**
 * The number a reader sees, taken out of the string the app rendered.
 *
 * Deliberately reads the *rendered* price rather than the quote: interlock 1 is a disagreement
 * between what one module produces and what another module thinks that number means, and only
 * the rendered form has both halves in it.
 */
function renderedAmount(app: App, amount: number): { text: string; value: number } {
  const text = fn<(n: number) => string>(app, 'formatPrice')(amount);
  return { text, value: Number(String(text).replace(/[^0-9.-]/g, '')) };
}

/** The banners the detail pane would show for one order, from both places one can come from. */
function banners(app: App, subject: OrderRecord): string[] {
  const sent = fn<(o: OrderRecord) => string[]>(app, 'confirmationsFor')(subject);
  const body = fn<(o: OrderRecord) => string>(app, 'confirmationBody')(subject);
  return body ? [...sent, body] : [...sent];
}

function check(id: string, title: string, body: (app: App) => Observation): AcceptanceCheck {
  return {
    id,
    title,
    run(tree: FileTree): CheckResult {
      let app: App;
      try {
        app = evaluate(tree);
      } catch (error) {
        return { id, verdict: 'error', observed: `the tree does not run: ${message(error)}` };
      }

      try {
        const observation = body(app);
        return { id, verdict: observation.pass ? 'pass' : 'fail', observed: observation.observed };
      } catch (error) {
        return { id, verdict: 'error', observed: message(error) };
      }
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// The ticket bodies. Named, because three of them are asked again by interlock 3 and asking
// them a second time in different words is how the two would drift apart.
// ---------------------------------------------------------------------------------------------

/** Money is counted in whole minor units, and rendering one puts the decimal point back. */
function moneyIsMinorUnits(app: App): Observation {
  const subject = order(app, SUBJECT_ORDER);
  const line = subject.lines[0];
  if (line === undefined) throw new Error(`${SUBJECT_ORDER} has no lines`);

  const total = fn<(l: OrderLine) => number>(app, 'lineTotal')(line);
  const rendered = renderedAmount(app, total);
  const symbol = app.CURRENCY.symbol;

  return {
    pass: Number.isInteger(total) && rendered.text === `${symbol}18.51`,
    observed: `${line.quantity} × ${line.price} totals ${total} and renders ${rendered.text}`,
  };
}

/**
 * Availability is served from a cache: the record moves and the next lookup does not.
 *
 * Asked by moving the shelf out from under the cache rather than by reading the source, so any
 * cache with a window wide enough to hold two calls answers it and no particular implementation
 * of one is required.
 */
function availabilityIsCached(app: App): Observation {
  const available = fn<(sku: string) => number>(app, 'availableStock');
  const onRecord = fn<(sku: string) => number>(app, 'stockOnRecord');

  const first = available(SCARCE_SKU);
  const moved = first + 10;
  app.INVENTORY[SCARCE_SKU] = moved;
  const second = available(SCARCE_SKU);

  return {
    pass: second === first && onRecord(SCARCE_SKU) === moved,
    observed:
      `first lookup ${first}; the shelf then moved to ${onRecord(SCARCE_SKU)} ` +
      `and the next lookup said ${second}`,
  };
}

/** Placing an order leaves a confirmation in the delivered log. */
function orderIsConfirmedByEmail(app: App): Observation {
  const result = place(app, 'SKU-MUG', 1);
  if (!result.ok || result.order === undefined) {
    return { pass: false, observed: `the order was refused: ${result.reason ?? 'no reason given'}` };
  }

  const sent = fn<(o: OrderRecord) => string[]>(app, 'confirmationsFor')(result.order);
  const first = sent[0] ?? '';

  return {
    pass: sent.length >= 1 && first.includes(result.order.id),
    observed: sent.length === 0 ? 'nothing was sent' : `${sent.length} sent, first reads "${first}"`,
  };
}

/** There is confirmation copy for an order, naming it. */
function confirmationCopyExists(app: App): Observation {
  const subject = order(app, SUBJECT_ORDER);
  const body = fn<(o: OrderRecord) => string>(app, 'confirmationBody')(subject);
  const text = typeof body === 'string' ? body.trim() : '';

  return {
    pass: text.length > 0 && text.includes(subject.id),
    observed: text.length === 0 ? 'the confirmation body is empty' : `reads "${text}"`,
  };
}

/**
 * The list pages: more than one page, every page non-empty, no order on two pages and none
 * missing from all of them.
 *
 * Pages are counted from zero because that is what the view does — `web/app.js` opens on
 * `view.page = 0` and asks the list for it.
 */
function listPages(app: App): Observation {
  const pageCount = fn<() => number>(app, 'orderPageCount')();
  const page = fn<(page: number) => OrderRecord[]>(app, 'allOrders');
  const total = app.ORDERS.length;

  const seen: string[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const rows = page(i);
    sizes.push(rows.length);
    for (const row of rows) seen.push(row.id);
  }

  const unique = new Set(seen);
  const everyOrder = new Set(app.ORDERS.map((row) => row.id));
  const covered = unique.size === everyOrder.size && [...unique].every((id) => everyOrder.has(id));
  const first = page(0).map((row) => row.id);
  const second = page(1).map((row) => row.id);
  const disjoint = first.every((id) => !second.includes(id));

  return {
    pass:
      pageCount > 1 &&
      first.length > 0 &&
      second.length > 0 &&
      disjoint &&
      covered &&
      seen.length === unique.size,
    observed:
      `${pageCount} pages of sizes [${sizes.join(', ')}] over ${total} orders; ` +
      `page 1 ${first.join(' ')} / page 2 ${second.join(' ')}`,
  };
}

/** An accepted status change is remembered, in order. */
function statusChangesAreRecorded(app: App): Observation {
  const history = fn<(id: string) => HistoryEntry[]>(app, 'statusHistory');
  const update = fn<(id: string, status: string) => OrderRecord | null>(app, 'updateOrderStatus');

  const subject = order(app, SUBJECT_ORDER);
  const before = history(subject.id).length;
  const moved = update(subject.id, 'picked');
  const after = history(subject.id);
  const last = after[after.length - 1];

  return {
    pass: moved !== null && after.length === before + 1 && last?.status === 'picked',
    observed:
      moved === null
        ? `the store refused to move ${subject.id} from ${subject.status} to picked`
        : `${before} entries before, ${after.length} after: ${after.map((e) => e.status).join(' → ')}`,
  };
}

/**
 * An order the shelf can cover succeeds and one it cannot is refused, with a reason.
 *
 * Three on the shelf: two goes through, and four does not — whether the guard reads the record
 * or a cached copy of it, because nothing has had time to go stale. That is what makes this a
 * check on one agent's work rather than on the composition.
 */
function oversellIsRefused(app: App): Observation {
  const first = place(app, SCARCE_SKU, 2);
  const second = place(app, SCARCE_SKU, 4);

  return {
    pass: first.ok === true && second.ok === false && (second.reason ?? '').length > 0,
    observed:
      `order of 2: ${first.ok ? 'accepted' : `refused (${first.reason ?? '?'})`}; ` +
      `order of 4: ${second.ok ? 'accepted' : `refused (${second.reason ?? '?'})`}`,
  };
}

/**
 * Shipping is priced, and priced in a unit the tariff recognises.
 *
 * Deliberately accepts **either** denomination. The tariff is published in decimal pounds and
 * an agent may reasonably answer in pounds or in minor units; both are the right answer to this
 * ticket asked on its own, and which one is right *here* is a fact about `lib/money.js` that
 * this module has no way to learn. The disagreement between the two is interlock 1's business,
 * below.
 */
function shippingIsPriced(app: App): Observation {
  const subject = order(app, SUBJECT_ORDER);
  const kg = fn<(o: OrderRecord) => number>(app, 'orderWeightKg')(subject);
  const tariff = app.SHIPPING_TARIFF;
  const scale = app.CURRENCY.minorUnitsPerUnit;

  const inPounds = tariff.baseCharge + tariff.perKilogram * kg;
  const inMinorUnits = Math.round(inPounds * scale);
  const quote = fn<(o: OrderRecord) => number>(app, 'shippingQuote')(subject);

  const asPounds = Math.abs(quote - inPounds) < 0.005;
  const asMinorUnits = Math.abs(quote - inMinorUnits) < 0.5;
  const denomination = asMinorUnits ? 'minor units' : asPounds ? 'pounds' : 'neither';

  return {
    pass: quote > 0 && (asPounds || asMinorUnits),
    observed:
      `${quote} for ${kg}kg — the tariff comes to ${inPounds.toFixed(3)} in pounds ` +
      `or ${inMinorUnits} in minor units, so this is in ${denomination}`,
  };
}

/**
 * One per ticket that carries code.
 *
 * `P2a` and `P2b` are the same work in different words and carry the same patch, so they carry
 * the same question — asked under both ids, because a lane that applied one of them and not the
 * other has still delivered the feature and must be able to say so. `A1` and `T11` are absent:
 * they patch nothing, and a check over an empty change is a check that cannot fail.
 */
export const TICKET_CHECKS: readonly AcceptanceCheck[] = [
  check('I3', 'money is counted in whole minor units', moneyIsMinorUnits),
  check('P2a', 'availability lookups are served from a cache', availabilityIsCached),
  check('P2b', 'availability lookups are served from a cache', availabilityIsCached),
  check('P6a', 'placing an order sends a confirmation', orderIsConfirmedByEmail),
  check('P6b', 'there is confirmation copy for an order', confirmationCopyExists),
  check('C1', 'the order list pages', listPages),
  check('C2', 'an accepted status change is recorded', statusChangesAreRecorded),
  check('C3', 'an order the shelf cannot cover is refused', oversellIsRefused),
  check('R3', 'shipping is priced in a unit the tariff recognises', shippingIsPriced),
];

// ---------------------------------------------------------------------------------------------
// The interlocks. Each one is a question about the assembled app that no single ticket's check
// can answer, and each is the exact question the naive lane gets wrong.
// ---------------------------------------------------------------------------------------------

/**
 * Interlock 1 — the shipping line renders at the magnitude the tariff says it should.
 *
 * The value, not a marker: the tariff for this parcel is £3.37, and a lane where the quote and
 * the formatter disagree about the unit renders £0.03. Both modules are individually right,
 * which is why `shippingIsPriced` above passes in the same tree this fails in.
 */
const shippingRendersAtTheRightMagnitude = check(
  'interlock-1',
  'the shipping line renders at the magnitude the tariff says',
  (app) => {
    const subject = order(app, SUBJECT_ORDER);
    const kg = fn<(o: OrderRecord) => number>(app, 'orderWeightKg')(subject);
    const tariff = app.SHIPPING_TARIFF;
    const expected = tariff.baseCharge + tariff.perKilogram * kg;

    const quote = fn<(o: OrderRecord) => number>(app, 'shippingQuote')(subject);
    const rendered = renderedAmount(app, quote);

    return {
      pass: Math.abs(rendered.value - expected) <= 0.01,
      observed:
        `shipping renders ${rendered.text}; the tariff for ${kg}kg is ` +
        `${app.CURRENCY.symbol}${expected.toFixed(2)}`,
    };
  },
);

/**
 * Interlock 2 — two orders of two against three on the shelf, and the second is refused.
 *
 * The guard is present in both lanes and both lanes refuse an oversell on a cold cache. This is
 * the one question that separates them: the second order arrives inside the cache window, so a
 * guard reading availability reads a number that was true a moment ago.
 */
const theShelfCannotGoNegative = check(
  'interlock-2',
  'a second order inside the cache window is still refused',
  (app) => {
    const onRecord = fn<(sku: string) => number>(app, 'stockOnRecord');
    const started = onRecord(SCARCE_SKU);

    const first = place(app, SCARCE_SKU, 2);
    const second = place(app, SCARCE_SKU, 2);
    const ended = onRecord(SCARCE_SKU);

    return {
      pass: first.ok === true && second.ok === false && ended >= 0,
      observed:
        `${started} on the shelf; first order of 2 ${first.ok ? 'accepted' : 'refused'}, ` +
        `second ${second.ok ? 'accepted' : `refused (${second.reason ?? '?'})`}, ` +
        `shelf left at ${ended}`,
    };
  },
);

/**
 * Interlock 3 — all three features of the contended file work in one tree.
 *
 * Three tickets edit one file in three disjoint regions; a merge tool takes all three without
 * complaint, and a whole-file write-back keeps one. This asks the three ticket questions again
 * over the same tree, so the failure names *which* feature is gone rather than reporting that
 * something is.
 */
const theContendedFileKeptEverything = check(
  'interlock-3',
  'pager, status history and oversell refusal all work in one tree',
  (app) => {
    const parts = [
      { name: 'pager', outcome: listPages(app) },
      { name: 'timeline', outcome: statusChangesAreRecorded(app) },
      { name: 'oversell', outcome: oversellIsRefused(app) },
    ];

    const missing = parts.filter((part) => !part.outcome.pass).map((part) => part.name);
    return {
      pass: missing.length === 0,
      observed:
        missing.length === 0
          ? 'all three present: ' + parts.map((part) => part.name).join(', ')
          : `missing: ${missing.join(', ')} — ` +
            parts
              .filter((part) => !part.outcome.pass)
              .map((part) => `${part.name}: ${part.outcome.observed}`)
              .join('; '),
    };
  },
);

/**
 * Interlock 4 — exactly one confirmation banner.
 *
 * Two agents implementing the same feature in two files merge cleanly, pass every check either
 * of them would write, and put the customer's confirmation on screen twice. Zero fails as well
 * as two: a lane that lost both halves has not passed this.
 */
const theConfirmationAppearsOnce = check(
  'interlock-4',
  'the confirmation banner appears exactly once',
  (app) => {
    const result = place(app, 'SKU-MUG', 1);
    if (!result.ok || result.order === undefined) {
      return { pass: false, observed: `the order was refused: ${result.reason ?? 'no reason given'}` };
    }

    const shown = banners(app, result.order);
    return {
      pass: shown.length === 1,
      observed:
        shown.length === 0
          ? 'no confirmation was shown at all'
          : `${shown.length} banner(s): ${shown.map((line) => `"${line}"`).join(' / ')}`,
    };
  },
);

/**
 * One per interlock, except the fifth.
 *
 * Interlock 5 leaves no difference in the code — A1 and T11 patch nothing — so no question
 * asked of a tree can separate the lanes. It is decided by the journey and the token meter, and
 * a check here that always passed would be worse than no check at all.
 */
export const COMPOSITION_CHECKS: readonly AcceptanceCheck[] = [
  shippingRendersAtTheRightMagnitude,
  theShelfCannotGoNegative,
  theContendedFileKeptEverything,
  theConfirmationAppearsOnce,
];

/** Runs a set of checks over one tree. Each check runs the tree fresh, because they mutate it. */
export function runChecks(checks: readonly AcceptanceCheck[], tree: FileTree): CheckResult[] {
  return checks.map((one) => one.run(tree));
}

/** The one check with this id, or a throw — a caller asking for a check that is gone has a bug. */
export function checkById(id: string): AcceptanceCheck {
  const found = [...TICKET_CHECKS, ...COMPOSITION_CHECKS].find((one) => one.id === id);
  if (found === undefined) throw new Error(`no acceptance check ${id}`);
  return found;
}

export function failed(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((result) => result.verdict !== 'pass');
}
