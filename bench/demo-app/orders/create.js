// PLACING AN ORDER — turning a request into a draft, checking the draft, and writing it.
//
// `validateDraft` answers the questions that can be answered from the draft alone: is the SKU
// one we sell, is the quantity a whole number of at least one, is there a customer on it. It
// deliberately answers nothing about stock, which is a question about the shelf rather than
// about the draft.
//
// `submitNewOrder` writes the draft and tells the customer. It reports `ok: true`.

var MAX_UNITS_PER_LINE = 25;

function orderLineFor(sku, quantity) {
  return { sku: sku, quantity: quantity, price: priceOf(sku) };
}

// A request may name one SKU or carry a list of lines. Both end up as the same draft.
function draftFromForm(form) {
  var lines = [];
  if (form.lines && form.lines.length) {
    for (var i = 0; i < form.lines.length; i += 1) {
      lines.push(orderLineFor(form.lines[i].sku, form.lines[i].quantity));
    }
  } else {
    lines.push(orderLineFor(form.sku, form.quantity));
  }

  return {
    id: nextOrderId(),
    customer: form.customer,
    status: 'placed',
    placedAt: nowIso(),
    lines: lines
  };
}

function validateLine(line) {
  if (!isTracked(line.sku)) {
    return { ok: false, reason: 'we do not sell ' + line.sku };
  }
  if (typeof line.quantity !== 'number' || isNaN(line.quantity)) {
    return { ok: false, reason: 'a quantity is required for ' + nameOf(line.sku) };
  }
  if (Math.floor(line.quantity) !== line.quantity || line.quantity < 1) {
    return { ok: false, reason: 'quantity for ' + nameOf(line.sku) + ' must be a whole number of at least one' };
  }
  if (line.quantity > MAX_UNITS_PER_LINE) {
    return { ok: false, reason: nameOf(line.sku) + ' is limited to ' + MAX_UNITS_PER_LINE + ' per order' };
  }
  return { ok: true };
}

function validateDraft(draft) {
  if (!draft.customer) {
    return { ok: false, reason: 'an order needs a customer' };
  }
  if (draft.lines.length === 0) {
    return { ok: false, reason: 'an order needs at least one line' };
  }

  for (var i = 0; i < draft.lines.length; i += 1) {
    var checked = validateLine(draft.lines[i]);
    if (!checked.ok) return checked;
  }
  return { ok: true };
}

function submitNewOrder(form) {
  var order = draftFromForm(form);

  var checked = validateDraft(order);
  if (!checked.ok) return checked;

  insertOrder(order);
  notifyOrderPlaced(order);
  return { ok: true, order: order };
}

// What the result pane says. A refusal carries its reason; a success carries what was written.
function describeResult(result) {
  if (result.ok) {
    return 'Order ' + result.order.id + ' placed for ' + result.order.customer + '.';
  }
  return 'Refused: ' + result.reason;
}

function orderValue(order) {
  return orderSubtotal(order) + taxForOrder(order) + shippingQuote(order);
}

// A draft priced up without writing anything — what the buttons would cost if they were
// pressed. Nothing here touches the store or the shelf.
function quoteDraft(form) {
  var draft = draftFromForm(form);
  var checked = validateDraft(draft);
  if (!checked.ok) return checked;

  return {
    ok: true,
    draft: draft,
    subtotal: orderSubtotal(draft),
    tax: taxForOrder(draft),
    shipping: shippingQuote(draft),
    total: orderValue(draft)
  };
}

function cancelOrder(id) {
  var order = findOrder(id);
  if (!order) return { ok: false, reason: 'no order ' + id };

  var updated = updateOrderStatus(id, 'cancelled');
  if (!updated) {
    return { ok: false, reason: 'an order that is ' + statusLabel(order.status) + ' cannot be cancelled' };
  }

  notifyOrderCancelled(updated);
  return { ok: true, order: updated };
}
