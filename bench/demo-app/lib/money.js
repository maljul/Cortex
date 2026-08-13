// MONEY — how an amount is represented, and therefore what every other module has to
// agree with.
//
// Baseline: amounts are floats taken straight off the record, so a line of three at 6.17
// renders as £18.509999999999998. I3 is the ticket that moves the representation to
// integer minor units.
//
// This module is one half of interlock 1. Once I3 lands, `formatPrice` takes minor units
// and anything that produces a price has to return them too. Nothing here can enforce
// that on `shipping/quote.js`, and nothing warns it — which is the whole point.

function formatPrice(amount) {
  return '£' + amount;
}

function lineTotal(line) {
  return line.price * line.quantity;
}

function sumAmounts(amounts) {
  var total = 0;
  for (var i = 0; i < amounts.length; i += 1) {
    total = total + amounts[i];
  }
  return total;
}
