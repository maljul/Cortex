// CUSTOMER EMAIL — the outbox, what happens to a message that fails, and the delivered log.
//
// A message goes into `OUTBOX`. `flushOutbox` walks it and hands each one to `attemptDelivery`;
// what survives moves to `SENT`, and what fails goes back on the queue with its attempt count
// raised until it runs out of attempts and lands in `FAILED`.
//
// `SENT` is the delivered log. `confirmationsFor` reads it, and it is the only record that a
// customer was told anything.
//
// `notifyOrderPlaced` is the hook the order flow calls when an order is written. It returns
// null.

var SENT = [];
var OUTBOX = [];
var FAILED = [];

var MAX_DELIVERY_ATTEMPTS = 3;

// Whether a delivery is accepted. There is no network here, so this stands in for one: an
// address with no `@` in it is rejected the way a gateway would reject it, and everything else
// is accepted.
function attemptDelivery(message) {
  if (String(message.to).indexOf('@') === -1) {
    return { ok: false, reason: 'unroutable address: ' + message.to };
  }
  return { ok: true };
}

function emailAddressFor(customer) {
  var slug = String(customer)
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/^ +| +$/g, '')
    .replace(/ +/g, '.');
  return slug + '@customers.example';
}

function queueEmail(order, subject, body) {
  var message = {
    orderId: order.id,
    to: emailAddressFor(order.customer),
    subject: subject,
    body: body,
    attempts: 0,
    queuedAt: nowIso()
  };
  OUTBOX.push(message);
  return message;
}

function markDelivered(message) {
  message.deliveredAt = nowIso();
  SENT = SENT.concat([message]);
  return message;
}

// Drains the outbox once. A message that fails goes back on the queue rather than being
// dropped, and a message that has used its attempts moves to `FAILED` so it stops being
// retried for ever.
function flushOutbox() {
  var pending = OUTBOX;
  OUTBOX = [];

  var delivered = 0;
  for (var i = 0; i < pending.length; i += 1) {
    var message = pending[i];
    message.attempts = message.attempts + 1;

    var outcome = attemptDelivery(message);
    if (outcome.ok) {
      markDelivered(message);
      delivered = delivered + 1;
    } else if (message.attempts >= MAX_DELIVERY_ATTEMPTS) {
      message.failedReason = outcome.reason;
      FAILED.push(message);
    } else {
      OUTBOX.push(message);
    }
  }
  return delivered;
}

function notifyOrderPlaced(order) {
  return null;
}

function notifyOrderShipped(order) {
  var message = queueEmail(order, subjectFor(order, 'shipped'), shippedBody(order));
  flushOutbox();
  return message;
}

function notifyOrderCancelled(order) {
  var message = queueEmail(order, subjectFor(order, 'cancelled'), cancelledBody(order));
  flushOutbox();
  return message;
}

function confirmationsFor(order) {
  var out = [];
  for (var i = 0; i < SENT.length; i += 1) {
    if (SENT[i].orderId === order.id) out.push(SENT[i].body);
  }
  return out;
}

function messagesFor(order) {
  var out = [];
  for (var i = 0; i < SENT.length; i += 1) {
    if (SENT[i].orderId === order.id) out.push(SENT[i]);
  }
  return out;
}

function sentCount() {
  return SENT.length;
}

function pendingCount() {
  return OUTBOX.length;
}

function failedCount() {
  return FAILED.length;
}

function outboxSummary() {
  return sentCount() + ' sent, ' + pendingCount() + ' pending, ' + failedCount() + ' failed';
}
