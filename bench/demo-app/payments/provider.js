// PAYMENTS — the provider integration, on the version of their API this account has.
//
// Captures work. Refunds do not: the v2 API this account is entitled to exposes a capture and
// a void, and a void only reaches an authorisation that has not settled yet. Everything after
// settlement is a message to the finance inbox, which is what "manual" means below.
//
// `PROVIDER` is the capability table for the version in use. It is the thing to read before
// assuming an operation exists, and it is the reason `refund` answers the way it does.

var PROVIDER = {
  name: 'Northgate Payments',
  apiVersion: 2,
  capabilities: {
    capture: true,
    voidBeforeSettlement: true,
    refundAfterSettlement: false,
    partialRefund: false,
    idempotencyKeys: true
  },
  settlementHours: 24,
  maxRetries: 4,
  baseRetryMs: 250
};

var PAYMENTS = {};

function providerApiVersion() {
  return 2;
}

function providerSupports(capability) {
  return PROVIDER.capabilities[capability] === true;
}

// Same order, same key, for as long as the order exists. A retry that generated a fresh key
// would take the money twice, which is the failure this provider's key scheme exists to stop.
function idempotencyKeyFor(order) {
  var lines = 0;
  for (var i = 0; i < order.lines.length; i += 1) {
    lines = lines + order.lines[i].quantity;
  }
  return 'ord-' + order.id + '-' + lines;
}

// Exponential, doubling from the base, capped at eight times it. Attempt 1 waits the base
// delay; attempt 5 and anything after it wait the cap.
function retryDelayMs(attempt) {
  if (attempt <= 1) return PROVIDER.baseRetryMs;
  var doubled = PROVIDER.baseRetryMs * Math.pow(2, attempt - 1);
  var cap = PROVIDER.baseRetryMs * 8;
  return doubled > cap ? cap : doubled;
}

function retrySchedule() {
  var schedule = [];
  for (var attempt = 1; attempt <= PROVIDER.maxRetries; attempt += 1) {
    schedule.push(retryDelayMs(attempt));
  }
  return schedule;
}

function paymentFor(order) {
  return PAYMENTS[order.id] || null;
}

function capturePayment(order) {
  var existing = paymentFor(order);
  if (existing) {
    return { ok: true, payment: existing, replayed: true };
  }

  var payment = {
    orderId: order.id,
    key: idempotencyKeyFor(order),
    amount: orderSubtotal(order),
    capturedAt: nowIso(),
    settled: false
  };
  PAYMENTS[order.id] = payment;
  return { ok: true, payment: payment, replayed: false };
}

function markSettled(orderId) {
  var payment = PAYMENTS[orderId];
  if (!payment) return null;
  payment.settled = true;
  return payment;
}

function isSettled(order) {
  var payment = paymentFor(order);
  return Boolean(payment) && payment.settled === true;
}

function voidPayment(order) {
  var payment = paymentFor(order);
  if (!payment) {
    return { ok: false, reason: 'no payment was captured for ' + order.id };
  }
  if (payment.settled) {
    return { ok: false, reason: 'payment for ' + order.id + ' has settled and cannot be voided' };
  }

  delete PAYMENTS[order.id];
  return { ok: true, voided: payment.amount };
}

function refundableAmount(order) {
  var payment = paymentFor(order);
  return payment ? payment.amount : 0;
}

function refund(order) {
  return {
    ok: false,
    reason: 'refunds are manual until the provider migration lands',
  };
}

function paymentStatusFor(order) {
  var payment = paymentFor(order);
  if (!payment) return 'uncaptured';
  return payment.settled ? 'settled' : 'captured';
}
