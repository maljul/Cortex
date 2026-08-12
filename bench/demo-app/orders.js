// The order records the dashboard renders, and the stock it is sold against.
// Prices are floats here on purpose; I3 is the ticket that fixes that.

const INVENTORY = {
  'SKU-COFFEE': 3,
  'SKU-MUG': 40,
  'SKU-BEANS': 12,
};

const ORDERS = [
  { id: 'A-1001', customer: 'R. Okonkwo', status: 'placed',    lines: [{ sku: 'SKU-COFFEE', quantity: 2, price: 6.17 }] },
  { id: 'A-1002', customer: 'M. Alvarez', status: 'picked',    lines: [{ sku: 'SKU-MUG',    quantity: 1, price: 9.99 }] },
  { id: 'A-1003', customer: 'S. Nakamura', status: 'shipped',  lines: [{ sku: 'SKU-BEANS',  quantity: 3, price: 4.05 }] },
  { id: 'A-1004', customer: 'T. Brennan',  status: 'placed',   lines: [{ sku: 'SKU-COFFEE', quantity: 1, price: 6.17 }] },
  { id: 'A-1005', customer: 'L. Fitzgerald', status: 'placed', lines: [{ sku: 'SKU-MUG',    quantity: 4, price: 9.99 }] },
  { id: 'A-1006', customer: 'D. Whitfield', status: 'picked',  lines: [{ sku: 'SKU-BEANS',  quantity: 2, price: 4.05 }] },
  { id: 'A-1007', customer: 'K. Adeyemi',  status: 'placed',   lines: [{ sku: 'SKU-COFFEE', quantity: 5, price: 6.17 }] },
];

function availableStock(sku) {
  return INVENTORY[sku] || 0;
}

function orderTotal(order) {
  return order.lines.reduce(function (sum, line) { return sum + lineTotal(line); }, 0);
}
