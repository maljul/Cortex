// SHIPPING — the module that has to agree with `lib/money.js` and has no way to find out
// what it decided.
//
// Baseline: every order ships free, because nothing prices it yet. R3 is the ticket that
// prices shipping, and R3 is only correct if it knows I3 moved money to integer minor units.
// An agent told that returns minor units; an agent not told returns pounds, and `formatPrice`
// divides it by a hundred.

function orderWeightKg(order) {
  var kg = 0;
  for (var i = 0; i < order.lines.length; i += 1) {
    kg = kg + order.lines[i].quantity * 0.25;
  }
  return kg;
}

function shippingQuote(order) {
  return 0;
}
