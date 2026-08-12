/**
 * THE DEMO'S CURATED CUT — the work five agents actually do on screen.
 *
 * `docs/superpowers/specs/2026-08-12-fleet-demo-design.md` §3. Eleven tickets against the
 * committed `bench/fixtures/` orders service, chosen so all four beats fire **by
 * construction** rather than by script.
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
 * implying a model wrote committed code.
 *
 * **Statement distances are measured, never chosen by ear** (`npm run measure:statements`,
 * V38). The numbers below are from live Titan with distances computed by the cluster's `<=>`.
 * Rewording anything here without re-measuring is how beat 4 was silently deleted once
 * before, at 0.2969.
 */

/** The file three agents need at once. The collision, and the screenshot. */
export const CONTENDED_FILE = 'src/orders/repository.ts';

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
  patches: DemoPatch[];
}

/**
 * The contended trio — `06` §4's "tasks touching overlapping file sets".
 *
 * Three legitimate, unrelated tickets that each need `src/orders/repository.ts`. Measured
 * pairwise at ≥ 0.7467 apart, so none of them dedupes against another: they are genuinely
 * different work that happens to share a file, which is the case `03` §3 is about.
 *
 * **The three patches do not overlap and do not conflict.** C1 rewrites `allOrders`, C2
 * rewrites `updateOrderStatus`, C3 adds a check inside `insertOrder`. A merge tool would take
 * all three without a murmur. What destroys two of them in the naive lane is last-write-wins
 * on the whole file — every agent read before the others wrote — and `test/patches.test.ts`
 * asserts both halves: that all three survive under arbitration, that exactly one survives
 * without it, and that the regions really are disjoint so the demo is not quietly showing a
 * merge conflict instead.
 */
const CONTENDED: DemoTask[] = [
  {
    id: 'C1',
    statement: 'Add pagination to the order list endpoint',
    resourceKeys: ['file:src/orders/list.ts', `file:${CONTENDED_FILE}`],
    patches: [
      {
        file: CONTENDED_FILE,
        find: `export async function allOrders(): Promise<Order[]> {
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY placed_at DESC');
  return rows;
}`,
        replace: `export async function allOrders(limit = 50, offset = 0): Promise<Order[]> {
  const { rows } = await pool.query(
    'SELECT * FROM orders ORDER BY placed_at DESC LIMIT $1 OFFSET $2',
    [limit, offset],
  );
  return rows;
}`,
      },
    ],
  },
  {
    id: 'C2',
    statement: 'Record a status transition history for every order',
    resourceKeys: ['file:src/orders/status.ts', `file:${CONTENDED_FILE}`],
    patches: [
      {
        file: CONTENDED_FILE,
        find: `export async function updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
  await pool.query('UPDATE orders SET status = $2 WHERE id = $1', [id, status]);
}`,
        replace: `export async function updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
  await pool.query('UPDATE orders SET status = $2 WHERE id = $1', [id, status]);
  await pool.query(
    'INSERT INTO order_status_history (order_id, status, changed_at) VALUES ($1,$2,now())',
    [id, status],
  );
}`,
      },
    ],
  },
  {
    id: 'C3',
    statement: 'Refuse order creation when the requested quantity exceeds available stock',
    resourceKeys: ['file:src/orders/create.ts', `file:${CONTENDED_FILE}`],
    patches: [
      {
        file: CONTENDED_FILE,
        find: `  for (const line of order.lines) {
    await pool.query(`,
        replace: `  for (const line of order.lines) {
    const stock = await pool.query('SELECT available FROM inventory WHERE sku = $1', [line.sku]);
    if ((stock.rows[0]?.available ?? 0) < line.quantity) {
      throw new Error('insufficient stock for ' + line.sku);
    }

    await pool.query(`,
      },
    ],
  },
];

/**
 * The cut so far. The remaining eight tickets — the two dedupe pairs, the recall pair, the
 * abandoned task and the eleventh task that abandonment spares — are U21's to add, each with
 * its patch and its measured distance.
 */
export const DEMO_TASKS: DemoTask[] = [...CONTENDED];

/** The patches one task carries. Throws rather than returning nothing for an unknown id. */
export function patchesFor(id: string): DemoPatch[] {
  const task = DEMO_TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`no demo task ${id}`);
  return task.patches;
}
