// THE NEW-ORDER FORM — C3's other file, and the surface a judge can click.
//
// Baseline: it reports success unconditionally, because nothing refuses an oversell yet.
// C3 patches this file *and* `orders/repository.js` — one adds the refusal, the other
// propagates it. A lane that keeps the guard and loses this file computes a refusal and
// throws it away, which is the most quietly wrong of the three possible states.
//
// **This is where interlock 2 becomes visible without reading any code.** Place two orders
// for the coffee that has three in stock. With the guard reading a cached stock level, the
// second one goes through and the level goes negative; with the guard reading the record, it
// is refused. Both agents wrote correct code.

function submitNewOrder(form) {
  var order = {
    id: nextOrderId(),
    customer: form.customer,
    status: 'placed',
    lines: [{ sku: form.sku, quantity: form.quantity, price: priceOf(form.sku) }],
  };

  insertOrder(order);
  notifyOrderPlaced(order);
  return { ok: true, order: order };
}
