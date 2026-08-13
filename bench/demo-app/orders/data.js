// The order records the dashboard renders, and the stock they are sold against.
//
// Prices are floats here on purpose — I3 is the ticket that changes what a price *is*.
// Seven orders, so C1's pager has more than one page to show.

var INVENTORY = {
  'SKU-COFFEE': 3,
  'SKU-MUG': 40,
  'SKU-BEANS': 12,
};

var CATALOGUE = {
  'SKU-COFFEE': { name: 'House filter, 250g', price: 6.17 },
  'SKU-MUG': { name: 'Enamel mug', price: 9.99 },
  'SKU-BEANS': { name: 'Espresso beans, 1kg', price: 4.05 },
};

var ORDERS = [
  { id: 'A-1001', customer: 'R. Okonkwo', status: 'placed', lines: [{ sku: 'SKU-COFFEE', quantity: 3, price: 6.17 }] },
  { id: 'A-1002', customer: 'M. Alvarez', status: 'picked', lines: [{ sku: 'SKU-MUG', quantity: 1, price: 9.99 }] },
  { id: 'A-1003', customer: 'S. Nakamura', status: 'shipped', lines: [{ sku: 'SKU-BEANS', quantity: 3, price: 4.05 }] },
  { id: 'A-1004', customer: 'T. Brennan', status: 'placed', lines: [{ sku: 'SKU-COFFEE', quantity: 1, price: 6.17 }] },
  { id: 'A-1005', customer: 'L. Fitzgerald', status: 'placed', lines: [{ sku: 'SKU-MUG', quantity: 4, price: 9.99 }] },
  { id: 'A-1006', customer: 'D. Whitfield', status: 'picked', lines: [{ sku: 'SKU-BEANS', quantity: 2, price: 4.05 }] },
  { id: 'A-1007', customer: 'K. Adeyemi', status: 'placed', lines: [{ sku: 'SKU-COFFEE', quantity: 5, price: 6.17 }] },
];

function priceOf(sku) {
  var entry = CATALOGUE[sku];
  return entry ? entry.price : 0;
}

function nameOf(sku) {
  var entry = CATALOGUE[sku];
  return entry ? entry.name : sku;
}

function nextOrderId() {
  return 'A-' + (1007 + ORDERS.length - 6);
}
