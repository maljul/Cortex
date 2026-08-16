/**
 * RUNNING THE CORPUS — the only way to find out whether an interlock actually breaks.
 *
 * Design §12 item 8: *"an interlock that merges cleanly and then works anyway is a dead beat,
 * and only running it can tell you which."* Reading two patches settles nothing about what
 * they do together, and since 2026-08-16 the corpus is deep enough that reading it settles
 * even less — the answer to a ticket lives across a module boundary, so the composed result is
 * the only thing worth asserting.
 *
 * This function was `evaluate` inside `test/demo-workload.test.ts`. It is here unchanged so
 * that the acceptance oracle (`bench/demo-app/acceptance.ts`) and that test run the *same*
 * execution, rather than two executions that drift.
 *
 * **`new Function`, not a module loader**, and that is the corpus's whole shape: the files
 * carry no module syntax at all, which is what lets `assembleApp` concatenate them into one
 * `srcdoc` document with no build step. Executing them the same way here means this runs
 * exactly the text the iframe will.
 *
 * **`web/app.js` is excluded** because it needs a document. Nothing is lost: every interlock is
 * a fact about the modules underneath the view.
 *
 * **A tree missing a file throws**, and deliberately. The returned object names every global
 * the baseline defines, so a lane that lost a whole file raises a `ReferenceError` here rather
 * than handing back an object with quiet holes in it. Callers that must survive that — the
 * acceptance checks do — catch it and report it as an error verdict.
 */
import { APP_FILES } from './app-bundle.js';
import type { FileTree } from './patches.js';

/**
 * The corpus files this executes, in load order: everything except the two documents and the
 * one script that needs a DOM.
 */
export const EVALUATED_FILES: readonly string[] = APP_FILES.filter((f) => !f.startsWith('web/'));

/**
 * What a run of the corpus hands back.
 *
 * Loose on purpose. The corpus is JavaScript the arms rewrite, so a static type here would be
 * a claim about code this module does not own; callers cast the entries they use, and a name
 * that stopped existing fails at the `new Function` boundary rather than being typed into
 * existence.
 */
export type App = Record<string, (...args: never[]) => unknown> & {
  ORDERS: { id: string; status: string; placedAt: string }[];
  INVENTORY: Record<string, number>;
  CURRENCY: { code: string; symbol: string; minorUnitsPerUnit: number };
  SHIPPING_TARIFF: { baseCharge: number; perKilogram: number; volumetricDivisor: number };
};

/**
 * Every global the baseline corpus defines, module by module in load order.
 *
 * Names a *patch* introduces are deliberately absent — `ORDERS_PER_PAGE` and `STOCK_CACHE` do
 * not exist until an agent's work lands, and naming them here would make the baseline itself
 * unevaluatable. `test/acceptance.test.ts` reads the corpus and fails if a baseline global is
 * missing from this list, because a forgotten name is invisible until a check reaches for it.
 */
export const EXPORTED_GLOBALS = [
  // lib/money.js
  'formatPrice', 'lineTotal', 'sumAmounts', 'roundPence', 'toMinorUnits', 'fromMinorUnits',
  'isWholeMinorUnits', 'applyRate', 'taxForLine', 'taxForOrder', 'orderSubtotal', 'allocate',
  'allocateByWeight', 'compareAmounts',
  // orders/data.js
  'CURRENCY', 'TAX_BANDS', 'SHIPPING_TARIFF', 'INVENTORY', 'RESERVATIONS', 'CATALOGUE',
  'STATUS_FLOW', 'STATUS_RANK', 'ORDERS', 'catalogueEntry', 'priceOf', 'nameOf', 'weightOf',
  'taxBandOf', 'taxRateOf', 'boxVolumeCm3', 'catalogueSkus', 'nextOrderId', 'nowIso',
  // inventory/repository.js
  'isTracked', 'stockOnRecord', 'reservedFor', 'availableStock', 'reserveStock',
  'releaseReservation', 'consumeStock', 'restock', 'stockLevels', 'lowStockSkus', 'isOversold',
  'oversoldSkus', 'quantityWanted', 'describeStock',
  // orders/repository.js
  'STATUS_HISTORY', 'findOrder', 'orderIndex', 'orderCount', 'compareOrders', 'sortedOrders',
  'allOrders', 'orderPageCount', 'ordersByStatus', 'isTerminalStatus', 'canTransition',
  'nextStatusesFor', 'updateOrderStatus', 'statusHistory', 'furthestStatus', 'insertOrder',
  'replaceOrder', 'ordersForSku', 'openOrders', 'orderLineCount',
  // shipping/quote.js
  'lineWeightKg', 'lineVolumeCm3', 'roundKg', 'actualWeightKg', 'volumetricWeightKg',
  'orderWeightKg', 'isVolumetric', 'shippingQuote', 'deliveryEstimateDays', 'formatWeight',
  'describeParcel', 'heaviestLine', 'shippingPerLine',
  // payments/provider.js
  'PROVIDER', 'PAYMENTS', 'providerApiVersion', 'providerSupports', 'idempotencyKeyFor',
  'retryDelayMs', 'retrySchedule', 'paymentFor', 'capturePayment', 'markSettled', 'isSettled',
  'voidPayment', 'refundableAmount', 'refund', 'paymentStatusFor',
  // notify/templates.js
  'BLANK', 'TEMPLATES', 'renderTemplate', 'unfilledSlots', 'pluralise', 'wrapAt',
  'lineDescription', 'itemisation', 'subjectFor', 'confirmationBody', 'shippedBody',
  'cancelledBody', 'refundBody', 'lowStockBody', 'bodyFor',
  // notify/email.js
  'SENT', 'OUTBOX', 'FAILED', 'MAX_DELIVERY_ATTEMPTS', 'attemptDelivery', 'emailAddressFor',
  'queueEmail', 'markDelivered', 'flushOutbox', 'notifyOrderPlaced', 'notifyOrderShipped',
  'notifyOrderCancelled', 'confirmationsFor', 'messagesFor', 'sentCount', 'pendingCount',
  'failedCount', 'outboxSummary',
  // orders/list.js
  'statusBadge', 'orderAmountCell', 'orderRow', 'tableHead', 'emptyListMessage', 'listCaption',
  'renderOrderList', 'renderPager', 'renderOrdersWithStatus', 'renderListSummary',
  'renderStatusCounts',
  // orders/status.js
  'STATUS_LABELS', 'statusLabel', 'elapsedSince', 'clockOf', 'statusProgress', 'renderProgress',
  'renderStatusActions', 'renderStatusPanel', 'renderStatusHeader', 'statusPaneFor',
  // orders/create.js
  'MAX_UNITS_PER_LINE', 'orderLineFor', 'draftFromForm', 'validateLine', 'validateDraft',
  'submitNewOrder', 'describeResult', 'orderValue', 'quoteDraft', 'cancelOrder',
] as const;

/** Runs a tree and hands back the globals it defines. */
export function evaluate(tree: FileTree): App {
  const source = EVALUATED_FILES.map((file) => tree[file] ?? '').join('\n');
  const factory = new Function(`${source}\nreturn { ${EXPORTED_GLOBALS.join(', ')} };`);
  return factory() as App;
}
