// THE ORDER STORE — reads, ordering, status changes and inserts, over the `ORDERS` array.
//
// Three rules hold here and each one is load-bearing somewhere else:
//
//   * **Reads are ordered.** `ORDERS` is in whatever order rows were written; every read that
//     reaches a view goes through `sortedOrders`, newest first, tie-broken by id. Without the
//     tie-break two renders of an unchanged list can disagree, because two orders share a
//     `placedAt` to the second.
//   * **A status change follows `STATUS_FLOW`.** `updateOrderStatus` refuses a transition the
//     flow does not allow and returns `null`, the same as it does for an unknown id. What it
//     does not do is remember that the change happened.
//   * **`insertOrder` returns a result object and never throws.** A caller that ignores the
//     result gets an order in the store either way, which is why the result carries `ok`
//     rather than the function raising.
//
// `STATUS_HISTORY` is declared here and nothing writes to it.

var STATUS_HISTORY = {};

function findOrder(id) {
  for (var i = 0; i < ORDERS.length; i += 1) {
    if (ORDERS[i].id === id) return ORDERS[i];
  }
  return null;
}

function orderIndex(id) {
  for (var i = 0; i < ORDERS.length; i += 1) {
    if (ORDERS[i].id === id) return i;
  }
  return -1;
}

function orderCount() {
  return ORDERS.length;
}

// Newest first. `placedAt` is not unique, so id descending breaks the tie and makes the order
// total: two calls on an unchanged list return the same sequence, which is the only reason a
// caller can rely on a position in it meaning anything.
function compareOrders(a, b) {
  if (a.placedAt !== b.placedAt) return a.placedAt < b.placedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function sortedOrders() {
  return ORDERS.slice().sort(compareOrders);
}

function allOrders() {
  return sortedOrders();
}

function orderPageCount() {
  return 1;
}

function ordersByStatus(status) {
  var rows = sortedOrders();
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].status === status) out.push(rows[i]);
  }
  return out;
}

function isTerminalStatus(status) {
  var onward = STATUS_FLOW[status];
  return Boolean(onward) && onward.length === 0;
}

function canTransition(from, to) {
  var onward = STATUS_FLOW[from];
  if (!onward) return false;
  for (var i = 0; i < onward.length; i += 1) {
    if (onward[i] === to) return true;
  }
  return false;
}

function nextStatusesFor(order) {
  var onward = STATUS_FLOW[order.status];
  return onward ? onward.slice() : [];
}

function updateOrderStatus(id, status) {
  var order = findOrder(id);
  if (!order) return null;
  if (!canTransition(order.status, status)) return null;
  order.status = status;
  return order;
}

function statusHistory(id) {
  return STATUS_HISTORY[id] || [];
}

// The furthest stage an order has reached, by `STATUS_RANK`. `cancelled` is outside the
// ranking on purpose — it is an exit rather than a stage — so an order that was cancelled
// reports the last ranked status it actually reached.
function furthestStatus(id) {
  var entries = statusHistory(id);
  var best = null;
  for (var i = 0; i < entries.length; i += 1) {
    var rank = STATUS_RANK[entries[i].status];
    if (typeof rank !== 'number') continue;
    if (best === null || rank > STATUS_RANK[best]) best = entries[i].status;
  }
  return best;
}

function insertOrder(order) {
  for (var i = 0; i < order.lines.length; i += 1) {
    consumeStock(order.lines[i].sku, order.lines[i].quantity);
  }
  ORDERS.unshift(order);
  return { ok: true, order: order };
}

function replaceOrder(id, order) {
  var at = orderIndex(id);
  if (at === -1) return null;
  ORDERS[at] = order;
  return order;
}

// Orders that mention a SKU, newest first. The stock pane uses it to explain a level rather
// than only report one.
function ordersForSku(sku) {
  var rows = sortedOrders();
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    if (quantityWanted(rows[i], sku) > 0) out.push(rows[i]);
  }
  return out;
}

function openOrders() {
  var rows = sortedOrders();
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    if (!isTerminalStatus(rows[i].status)) out.push(rows[i]);
  }
  return out;
}

function orderLineCount(order) {
  var lines = 0;
  for (var i = 0; i < order.lines.length; i += 1) {
    lines = lines + order.lines[i].quantity;
  }
  return lines;
}
