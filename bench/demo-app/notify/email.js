// CUSTOMER NOTIFICATIONS — the other file that can implement the same feature.
//
// Baseline: placing an order notifies nobody. P6a is the ticket that sends the order
// confirmation. See `notify/templates.js` for its twin.

var SENT = [];

function notifyOrderPlaced(order) {
  return null;
}

function confirmationsFor(order) {
  var out = [];
  for (var i = 0; i < SENT.length; i += 1) {
    if (SENT[i].orderId === order.id) out.push(SENT[i].body);
  }
  return out;
}
