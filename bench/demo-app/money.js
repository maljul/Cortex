// Price formatting. Baseline: naive floating point, straight from the record.
// I3 replaces this with integer minor units.

function formatPrice(amount) {
  return '£' + amount;
}

function lineTotal(line) {
  return line.price * line.quantity;
}
