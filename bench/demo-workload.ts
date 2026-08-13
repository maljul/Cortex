/**
 * THE DEMO'S CURATED CUT — the work five agents actually do on screen.
 *
 * `docs/superpowers/specs/2026-08-12-fleet-demo-design.md` §3. Eleven tickets against the
 * demo-owned corpus in `bench/demo-app/`, chosen so all four beats fire **by construction**
 * rather than by script.
 *
 * **Why this file is here and not in `bench/tasks.json`.** That file is the *benchmark's*
 * corpus. `08` §4's end-of-day-two gate passed against exactly 30 tasks with the results
 * committed under `bench/results/`, and design §1 freezes both. An eleventh task added there
 * would change the published workload and invalidate the table. So the cut references
 * benchmark ids and adds its own, and `bench/tasks.json` is not touched.
 *
 * **Why `bench/` and not `src/demo/`.** The patch bodies are fixture source, and fixture
 * source contains SQL. `scripts/gate-mechanical.sh` keeps SQL out of `src/` outside
 * `src/memory/` and `src/db/`, and it is right to — so this belongs beside the fixtures it
 * patches. The apply logic, which contains no SQL, is `src/demo/patches.ts`.
 *
 * **The patches are committed, not model-authored.** Julian's call on 2026-08-13, reasoning
 * in `docs/DECISIONS.md`. Agents read the real file, decide, claim through the one
 * arbitration transaction, apply and close — the coordination is entirely live against the
 * real cluster; only the code content is fixed. `06` §5's methodological point is that any
 * difference between the arms must be attributable to the coordination layer, and identical
 * patches in both lanes make that airtight: the naive lane loses a **known** hunk and the
 * page can name which. **The page must say the patches are authored** — `07` §4 forbids
 * implying a model wrote committed code. Since V49 that obligation extends to one **closure
 * note** as well; see `CLOSURE NOTES` below.
 *
 * **Statement distances are measured, never chosen by ear** (`npm run measure:statements`,
 * V38 and V49). The numbers below are from live Titan with distances computed by the cluster's
 * `<=>`. Rewording anything here without re-measuring is how beat 4 was silently deleted once
 * before, at 0.2969.
 *
 * ## CLOSURE NOTES — the second thing that has to be measured
 *
 * V49 is the finding that shaped this file. Two of design §3.1's interlocks work by recall
 * carrying one agent's decision across a module boundary, and whether that works at all
 * depends on the distance between the **consolidated fact** and the *other* task's statement —
 * not between the two statements, which is what V38 measured.
 *
 *   I3 → R3   the fact is `03` §4.4's own fallback, "<statement> — done"    0.4323   REACHES
 *   P2 → C3   the same fallback                                            0.8459   too far
 *   P2 → C3   `closureNote` naming the work the cache endangers            0.3633   REACHES
 *
 * So **I3 writes no note at all** — the mechanism's default carries interlock 1, which is the
 * strongest available form of it — and **P2 writes one**, because nothing an agent would
 * naturally say about adding a cache lands within recall's 0.60 of the task the cache breaks.
 * Three ordinary phrasings measured 0.8459, 0.7183 and 0.6544. That note is authored, it is
 * labelled as authored, and the page must not claim consolidation *derived* the warning: what
 * the mechanism does is **carry** it to the agent whose work it affects.
 *
 * The rule V49 generalised, now measured on two unrelated pairs: **a note that names the change
 * is unreachable; a note that names the work the change endangers is reachable.** V39 found the
 * same thing from the abandonment side (0.6725 for the obstacle, 0.4698 for the work).
 */
import { factFromClosedIntent } from '../src/memory/consolidate.js';

/** The file three agents need at once. The collision, and the screenshot. */
export const CONTENDED_FILE = 'orders/repository.js';

export interface DemoPatch {
  file: string;
  find: string;
  replace: string;
}

export interface DemoTask {
  /** Benchmark id where the statement is reused, so the corpus stays traceable. */
  id: string;
  statement: string;
  resourceKeys: string[];
  /** What this task closes as. `abandoned` never applies a patch. */
  result: 'done' | 'abandoned';
  /**
   * What this task's agent writes down when it closes, or `null` to let `03` §4.4 derive its
   * own fact from the statement and the result.
   *
   * `null` is the better answer wherever it works, because a fact the mechanism produced is
   * not a fact the demo authored. It works for I3 and does not for P2 — see this file's
   * header.
   */
  closureNote: string | null;
  patches: DemoPatch[];
  /**
   * The patches this agent applies **instead**, when recall handed it the decision it needed.
   *
   * Not a second implementation of the ticket: the same feature, done in the representation
   * the other agent chose. Both versions are correct in isolation, which is what makes the
   * interlock an interlock rather than a bug.
   */
  informedPatches?: DemoPatch[];
  /**
   * The task whose consolidated fact makes `informedPatches` the right choice. The runner
   * compares recall's returned `fact` against `factOf` that task **exactly**, so being
   * informed requires the whole chain: closed intent → changefeed → consolidation → finding →
   * recall. A missing link leaves the agent uninformed, which is the honest outcome.
   */
  informedBy?: string;
  /**
   * The task whose finding makes this one unnecessary. The spared agent — interlock 5.
   *
   * Deliberately **not** dedupe: `03` §4.2's candidate set is `status IN ('in_flight','done')`
   * so an abandoned intent can never dedupe anything, and that exclusion stays. A later agent
   * is *informed* that something was given up, never *stopped* from trying.
   */
  sparedBy?: string;
}

/**
 * The sentence this task's closure will put into `findings`.
 *
 * Derived through `factFromClosedIntent` rather than reimplemented, so the workload cannot
 * drift away from what the changefeed sink actually writes. `test/demo-workload.test.ts`
 * asserts the two agree — if `03` §4.4's fallback format ever changes, that test fails
 * instead of the demo silently going uninformed on the deployed page.
 */
export function factOf(task: DemoTask): string {
  const fact = factFromClosedIntent({
    statement: task.statement,
    status: task.result,
    outcome: { result: task.result, ...(task.closureNote ? { notes: task.closureNote } : {}) },
  });
  if (fact === null) throw new Error(`no fact derivable for ${task.id}`);
  return fact;
}

/**
 * The two duplicate pairs — `06` §4's "semantically equivalent tasks, differently worded".
 *
 * P6a/P6b at **0.0610** and P2a/P2b at **0.2058**, both well inside dedupe's 0.39. Chosen on
 * margin from six candidate pairs (V38); P3 was rejected at 0.3630 as too thin and P1 (0.3203)
 * is the reserve.
 *
 * They demonstrate two different shapes on purpose. **P6's halves touch different files**, so
 * dedupe fires with no claim overlap at all — which is design §3.1's interlock 4 and the
 * isolation proof in one line: two files, no conflict, a clean merge, and the confirmation
 * banner rendered twice. **P2's halves touch the same file**, so without arbitration they also
 * collide.
 */
const DUPLICATES: DemoTask[] = [
  {
    id: 'P6a',
    statement: 'Send an order confirmation email when an order is placed',
    resourceKeys: ['file:notify/email.js'],
    result: 'done',
    closureNote: null,
    patches: [
      {
        file: 'notify/email.js',
        find: `function notifyOrderPlaced(order) {
  return null;
}`,
        replace: `function notifyOrderPlaced(order) {
  SENT.push({
    orderId: order.id,
    body: 'Order ' + order.id + ' is confirmed. A receipt is on its way to ' + order.customer + '.',
  });
  return SENT[SENT.length - 1];
}`,
      },
    ],
  },
  {
    id: 'P6b',
    statement: 'Email an order confirmation to the customer once the order is placed',
    resourceKeys: ['file:notify/templates.js'],
    result: 'done',
    closureNote: null,
    patches: [
      {
        // The **same sentence** as P6a's, deliberately. Two agents doing the same work do not
        // produce complementary halves of a feature; they each produce the whole thing. Word
        // them differently and a reader wonders which is right — identical, and the doubling
        // is unmistakable.
        file: 'notify/templates.js',
        find: `function confirmationBody(order) {
  return '';
}`,
        replace: `function confirmationBody(order) {
  return 'Order ' + order.id + ' is confirmed. A receipt is on its way to ' + order.customer + '.';
}`,
      },
    ],
  },
  {
    id: 'P2a',
    statement: 'Cache inventory availability lookups for thirty seconds',
    resourceKeys: ['file:inventory/repository.js'],
    result: 'done',
    // Measured at **0.3633** from C3's statement, where the three phrasings an agent would
    // naturally reach for measured 0.8459, 0.7183 and 0.6544 (V49). This is the note that
    // makes interlock 2 exist, and it is authored — see this file's header.
    closureNote:
      'Refusing order creation when the requested quantity exceeds available stock is now unsafe: availability lookups are cached for thirty seconds',
    patches: [
      {
        file: 'inventory/repository.js',
        find: `function availableStock(sku) {
  return stockOnRecord(sku);
}`,
        replace: `var STOCK_CACHE = {};
var STOCK_CACHE_MS = 30000;

function availableStock(sku) {
  var hit = STOCK_CACHE[sku];
  if (hit && Date.now() - hit.at < STOCK_CACHE_MS) return hit.value;

  var value = stockOnRecord(sku);
  STOCK_CACHE[sku] = { at: Date.now(), value: value };
  return value;
}`,
      },
    ],
  },
];

/**
 * P2b is P2a's work in different words, and it carries the **same patch and the same note**.
 *
 * Not a copy for convenience: whichever of the two the cluster grants must produce the same
 * finding, or interlock 2 would depend on which agent won a race. `factOf(P2a)` and
 * `factOf(P2b)` are asserted equal, which is why `informedBy: 'P2a'` is sufficient below.
 */
const P2B: DemoTask = {
  ...DUPLICATES[2]!,
  id: 'P2b',
  statement: 'Add a thirty second cache to inventory stock level lookups',
};

/**
 * The contended trio — `06` §4's "tasks touching overlapping file sets", and design §3.1's
 * interlock 3.
 *
 * Three legitimate, unrelated tickets that each need `orders/repository.js`. Measured pairwise
 * at ≥ 0.7467 apart, so none of them dedupes against another: they are genuinely different
 * work that happens to share a file, which is the case `03` §3 is about.
 *
 * **The three patches do not overlap and do not conflict.** C1 rewrites `allOrders`, C2
 * rewrites `updateOrderStatus`, C3 adds a check inside `insertOrder`. A merge tool would take
 * all three without a murmur. What destroys two of them in the naive lane is last-write-wins
 * on the whole file, and `test/patches.test.ts` asserts both halves.
 *
 * **Each of them also patches a second file that nobody else touches**, which is what makes
 * the loss legible rather than total: the naive lane keeps the view change and loses the store
 * change, so the pager renders and does not page, the timeline renders and stays empty, or the
 * refusal is computed and thrown away.
 */
const CONTENDED: DemoTask[] = [
  {
    id: 'C1',
    statement: 'Add pagination to the order list endpoint',
    resourceKeys: ['file:orders/list.js', `file:${CONTENDED_FILE}`],
    result: 'done',
    closureNote: null,
    patches: [
      {
        file: CONTENDED_FILE,
        find: `function allOrders() {
  return ORDERS.slice();
}

function orderPageCount() {
  return 1;
}`,
        replace: `var ORDERS_PER_PAGE = 4;

function allOrders(page, perPage) {
  var size = perPage || ORDERS_PER_PAGE;
  var start = (page || 0) * size;
  return ORDERS.slice(start, start + size);
}

function orderPageCount(perPage) {
  return Math.ceil(ORDERS.length / (perPage || ORDERS_PER_PAGE));
}`,
      },
      {
        file: 'orders/list.js',
        find: '  var rows = allOrders();',
        replace: '  var rows = allOrders(page);',
      },
      {
        file: 'orders/list.js',
        find: `function renderPager(page) {
  return '<p class="muted">' + allOrders().length + ' orders, all of them</p>';
}`,
        replace: `function renderPager(page) {
  var pages = orderPageCount();
  var current = page || 0;
  var html = '';
  for (var i = 0; i < pages; i += 1) {
    html +=
      '<button class="page-set' + (i === current ? ' current' : '') + '" data-page="' + i + '">' +
      (i + 1) + '</button>';
  }
  return '<nav class="pager"><span>page</span>' + html + '</nav>';
}`,
      },
    ],
  },
  {
    id: 'C2',
    statement: 'Record a status transition history for every order',
    resourceKeys: ['file:orders/status.js', `file:${CONTENDED_FILE}`],
    result: 'done',
    closureNote: null,
    patches: [
      {
        file: CONTENDED_FILE,
        find: `function updateOrderStatus(id, status) {
  var order = findOrder(id);
  if (!order) return null;
  order.status = status;
  return order;
}`,
        replace: `function updateOrderStatus(id, status) {
  var order = findOrder(id);
  if (!order) return null;
  order.status = status;
  if (!STATUS_HISTORY[id]) STATUS_HISTORY[id] = [];
  STATUS_HISTORY[id].push({ status: status, at: new Date().toISOString() });
  return order;
}`,
      },
      {
        file: 'orders/status.js',
        find: `function renderStatusPanel(order) {
  return '<p class="empty">No status history is recorded for this order.</p>';
}`,
        replace: `function renderStatusPanel(order) {
  var entries = statusHistory(order.id);
  if (entries.length === 0) {
    return '<p class="empty">No status history is recorded for this order.</p>';
  }

  var html = '';
  for (var i = 0; i < entries.length; i += 1) {
    html +=
      '<li>' + entries[i].status +
      ' <time>' + entries[i].at.slice(11, 19) + '</time></li>';
  }
  return '<ol class="timeline">' + html + '</ol>';
}`,
      },
    ],
  },
  {
    id: 'C3',
    statement: 'Refuse order creation when the requested quantity exceeds available stock',
    resourceKeys: ['file:orders/create.js', `file:${CONTENDED_FILE}`],
    result: 'done',
    closureNote: null,
    informedBy: 'P2a',
    patches: [
      {
        file: CONTENDED_FILE,
        find: `function insertOrder(order) {
  for (var i = 0; i < order.lines.length; i += 1) {
    consumeStock(order.lines[i].sku, order.lines[i].quantity);
  }`,
        replace: `function insertOrder(order) {
  for (var g = 0; g < order.lines.length; g += 1) {
    var wanted = order.lines[g];
    if (availableStock(wanted.sku) < wanted.quantity) {
      return {
        ok: false,
        reason: 'insufficient stock for ' + nameOf(wanted.sku) + ': ' + availableStock(wanted.sku) + ' left',
      };
    }
  }

  for (var i = 0; i < order.lines.length; i += 1) {
    consumeStock(order.lines[i].sku, order.lines[i].quantity);
  }`,
      },
      {
        file: 'orders/create.js',
        find: `  insertOrder(order);
  notifyOrderPlaced(order);
  return { ok: true, order: order };`,
        replace: `  var result = insertOrder(order);
  if (!result.ok) return result;

  notifyOrderPlaced(order);
  return { ok: true, order: order };`,
      },
    ],
    /**
     * The same guard, reading the record instead of the cache.
     *
     * `stockOnRecord` is in the baseline and P2 does not touch it, so this variant depends on
     * nothing another agent has to have done — only on having been *told*. Both versions
     * refuse an oversell correctly on a cold cache; they differ only after an order has
     * consumed stock inside the cache window, which is precisely the composition neither
     * agent could see alone.
     */
    informedPatches: [
      {
        file: CONTENDED_FILE,
        find: `function insertOrder(order) {
  for (var i = 0; i < order.lines.length; i += 1) {
    consumeStock(order.lines[i].sku, order.lines[i].quantity);
  }`,
        replace: `function insertOrder(order) {
  for (var g = 0; g < order.lines.length; g += 1) {
    var wanted = order.lines[g];
    // Recall warned this agent that availability lookups are cached for thirty seconds, so
    // the guard reads the record rather than the cache. Nothing in this file said so.
    if (stockOnRecord(wanted.sku) < wanted.quantity) {
      return {
        ok: false,
        reason: 'insufficient stock for ' + nameOf(wanted.sku) + ': ' + stockOnRecord(wanted.sku) + ' left',
      };
    }
  }

  for (var i = 0; i < order.lines.length; i += 1) {
    consumeStock(order.lines[i].sku, order.lines[i].quantity);
  }`,
      },
      {
        file: 'orders/create.js',
        find: `  insertOrder(order);
  notifyOrderPlaced(order);
  return { ok: true, order: order };`,
        replace: `  var result = insertOrder(order);
  if (!result.ok) return result;

  notifyOrderPlaced(order);
  return { ok: true, order: order };`,
      },
    ],
  },
];

/**
 * The recall pair — design §3.1's interlock 1, and the one the design calls the money shot.
 *
 * I3/R3 sit at **0.4293**: outside dedupe by 0.0393 and inside recall by 0.1707. **The pair
 * only works because the two thresholds differ**, which is V34's ordering argument showing up
 * as a task pair — R3 must not be deduped against I3 (it is different work) and must recall
 * what I3 decided (it is dependent work).
 *
 * What R3's agent actually recalls is I3's *finding*, measured at **0.4323** from R3's
 * statement (V49), and it is `03` §4.4's own fallback sentence. Nothing is authored to make
 * this beat fire.
 */
const RECALL_PAIR: DemoTask[] = [
  {
    id: 'I3',
    statement: 'Store monetary amounts as integer minor units instead of floating point',
    resourceKeys: ['file:lib/money.js'],
    result: 'done',
    closureNote: null,
    patches: [
      {
        file: 'lib/money.js',
        find: `function formatPrice(amount) {
  return '£' + amount;
}

function lineTotal(line) {
  return line.price * line.quantity;
}`,
        replace: `function formatPrice(minorUnits) {
  return '£' + (minorUnits / 100).toFixed(2);
}

function lineTotal(line) {
  return Math.round(line.price * 100) * line.quantity;
}`,
      },
    ],
  },
  {
    id: 'R3',
    statement: 'Convert stored shipping quotes to the new integer minor unit representation',
    resourceKeys: ['file:shipping/quote.js'],
    result: 'done',
    closureNote: null,
    informedBy: 'I3',
    /**
     * Pounds — the correct answer to this ticket read on its own, by an agent that has the
     * old `lib/money.js` in front of it or has not looked. £2.99 plus 50p a kilo is a
     * shipping quote; nothing about it is careless.
     *
     * Composed with I3's `formatPrice`, which now divides by a hundred, the shipping line
     * renders £0.03 where it should read £3.37, and the order total adds pounds to minor
     * units. Measured, not estimated: `2.99 + 0.5 * 0.75` is 3.365.
     */
    patches: [
      {
        file: 'shipping/quote.js',
        find: `function shippingQuote(order) {
  return 0;
}`,
        replace: `function shippingQuote(order) {
  return 2.99 + 0.5 * orderWeightKg(order);
}`,
      },
    ],
    informedPatches: [
      {
        file: 'shipping/quote.js',
        find: `function shippingQuote(order) {
  return 0;
}`,
        replace: `function shippingQuote(order) {
  // Recall handed this agent the decision I3 took — amounts are integer minor units — so the
  // quote is minor units too. Nothing in this file could have told it that.
  return Math.round(299 + 50 * orderWeightKg(order));
}`,
      },
    ],
  },
];

/**
 * The abandoned task and the agent it spares — design §3.1's interlock 5.
 *
 * A1 is impossible: the provider's v3 API is not on this account. Until V39 that knowledge
 * reached nobody — consolidation ignored abandoned rows, and `findDuplicate` excludes them —
 * so the fleet paid for its most expensive knowledge and discarded it. Now abandonment
 * consolidates, and what is *embedded* is the restatement rather than the reason, because the
 * reason names the obstacle and the restatement names the work (V39: 0.6725 against 0.4698).
 *
 * **T11 is the eleventh ticket and it must not go in `bench/tasks.json`** (Julian,
 * 2026-08-12): `08` §4's passed gate freezes that file at 30 tasks with committed results.
 * Measured at **0.4698** from A1's retrieval key — recalled — and **0.8422** from the nearest
 * live task in the cut, so it cannot be deduped by accident (V38, confirmed V49).
 *
 * **Neither task patches anything**, and that is the interlock rather than a gap. The
 * difference between the lanes is not a line of code — it is whether the second agent spends
 * its budget rediscovering the dead end. `src/demo/attribution.ts` correctly reports nothing
 * here; the journey and the token meter are where this shows.
 */
const ABANDONED: DemoTask[] = [
  {
    id: 'A1',
    statement: 'Migrate the payment provider integration to their version three API',
    resourceKeys: ['file:payments/provider.js'],
    result: 'abandoned',
    closureNote:
      "The provider's v3 API is not available on this account, so the work cannot be completed.",
    patches: [],
  },
  {
    id: 'T11',
    statement: "Move the refund flow onto the payment provider's v3 API",
    resourceKeys: ['file:payments/provider.js'],
    result: 'abandoned',
    closureNote:
      "The provider's v3 API is not available on this account, so the work cannot be completed.",
    patches: [],
    sparedBy: 'A1',
  },
];

/**
 * The cut, in the order the fleet takes it up.
 *
 * **The order is load-bearing for two of the interlocks and for nothing else.** I3 must close
 * before R3 asks what is known, and P2 before C3 does, or there is no finding to recall and
 * both agents are honestly uninformed. Everything else about the run is concurrent and
 * decided by the cluster.
 */
export const DEMO_TASKS: DemoTask[] = [
  ...RECALL_PAIR.slice(0, 1), // I3 — informs R3
  DUPLICATES[2]!, // P2a — informs C3
  P2B,
  ...DUPLICATES.slice(0, 2), // P6a, P6b
  ...CONTENDED, // C1, C2, C3
  ...RECALL_PAIR.slice(1), // R3
  ...ABANDONED, // A1, T11
];

/** The ten benchmark-derived tickets. `T11` is the eleventh and demo-owned. */
export const CUT_IDS: readonly string[] = ['P6a', 'P6b', 'P2a', 'P2b', 'C1', 'C2', 'C3', 'I3', 'R3', 'A1'];

export function taskById(id: string): DemoTask {
  const task = DEMO_TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`no demo task ${id}`);
  return task;
}

/** The patches one task carries. Throws rather than returning nothing for an unknown id. */
export function patchesFor(id: string, informed = false): DemoPatch[] {
  const task = taskById(id);
  return informed && task.informedPatches ? task.informedPatches : task.patches;
}
