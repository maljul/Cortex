// THE ORDER STORE — the file three tickets need at once.
//
// C1 pages `allOrders`, C2 records a transition in `updateOrderStatus`, C3 puts an oversell
// guard in `insertOrder`. Three separate features, three disjoint regions, no textual
// conflict anywhere: a merge tool would take all three without a murmur. What loses two of
// them is one agent writing this whole file back over a copy it read before the others
// saved.
//
// `insertOrder` returns a result object rather than throwing, in the baseline, so that a
// lane which ends up with the guard and not its caller — or the caller and not the guard —
// still renders. A thrown error would blank the pane and read as "the mechanism lost the
// whole file" instead of showing exactly which feature went missing.

var STATUS_HISTORY = {};

function findOrder(id) {
  for (var i = 0; i < ORDERS.length; i += 1) {
    if (ORDERS[i].id === id) return ORDERS[i];
  }
  return null;
}

function allOrders() {
  return ORDERS.slice();
}

function orderPageCount() {
  return 1;
}

function updateOrderStatus(id, status) {
  var order = findOrder(id);
  if (!order) return null;
  order.status = status;
  return order;
}

function statusHistory(id) {
  return STATUS_HISTORY[id] || [];
}

function insertOrder(order) {
  for (var i = 0; i < order.lines.length; i += 1) {
    consumeStock(order.lines[i].sku, order.lines[i].quantity);
  }
  ORDERS.unshift(order);
  return { ok: true, order: order };
}
