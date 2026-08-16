// THE RECORDS — the catalogue, the stock ledger, the orders, and the tables that decide what
// a status change and a shipping charge are allowed to be.
//
// Everything here is data. Nothing in this file reads another module, which is why it loads
// second: every module after it may read these tables at call time.
//
// Two things about the numbers, because neither is obvious from looking at them:
//
//   * `price`, `SHIPPING_TARIFF` and `TAX_BANDS` are written the way the finance sheet writes
//     them — decimal pounds and decimal rates. Nothing in this file says what the rest of the
//     application is entitled to assume about that.
//   * `INVENTORY` is stock on the shelf. It is not stock available to sell: a reservation
//     holds units that are still on the shelf and are already spoken for.

var CURRENCY = {
  code: 'GBP',
  symbol: '£',
  minorUnitsPerUnit: 100
};

// Rates, not percentages. `TAX_BANDS.standard` is 0.2, meaning twenty per cent.
var TAX_BANDS = {
  standard: 0.2,
  reduced: 0.05,
  zero: 0
};

// Charges in decimal pounds, and a divisor. `volumetricDivisor` turns centimetres cubed into
// the kilograms a carrier bills for, which is how a light bulky parcel costs more than it
// weighs.
var SHIPPING_TARIFF = {
  baseCharge: 2.99,
  perKilogram: 0.5,
  volumetricDivisor: 5000
};

// Stock on the shelf, by SKU.
var INVENTORY = {
  'SKU-COFFEE': 3,
  'SKU-MUG': 40,
  'SKU-BEANS': 12,
  'SKU-FILTER': 6
};

// Units on the shelf that are already spoken for. Absent means none.
var RESERVATIONS = {
  'SKU-MUG': 2
};

var CATALOGUE = {
  'SKU-COFFEE': {
    name: 'House filter, 250g',
    price: 6.17,
    weightKg: 0.25,
    boxCm: { length: 10, width: 8, height: 12 },
    taxBand: 'zero'
  },
  'SKU-MUG': {
    name: 'Enamel mug',
    price: 9.99,
    weightKg: 0.4,
    boxCm: { length: 12, width: 10, height: 12 },
    taxBand: 'standard'
  },
  'SKU-BEANS': {
    name: 'Espresso beans, 1kg',
    price: 4.05,
    weightKg: 1,
    boxCm: { length: 20, width: 15, height: 12 },
    taxBand: 'zero'
  },
  'SKU-FILTER': {
    name: 'Paper filters, box of 200',
    price: 3.4,
    weightKg: 0.05,
    boxCm: { length: 25, width: 20, height: 10 },
    taxBand: 'standard'
  }
};

// The statuses an order may move to from the one it is in. A status with no successors is
// terminal, and there is no route back out of one.
var STATUS_FLOW = {
  placed: ['picked', 'cancelled'],
  picked: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: []
};

// How far through the flow a status is. `cancelled` is deliberately outside the ranking: it
// is an exit, not a stage, and comparing it against `shipped` is a question with no answer.
var STATUS_RANK = {
  placed: 0,
  picked: 1,
  shipped: 2,
  delivered: 3
};

// Fourteen orders. `placedAt` is the sort key the list view pages through, and it is not
// unique — A-1006 and A-1007 were written in the same second, which is why anything that
// orders this list needs a tie-break to be reproducible.
var ORDERS = [
  { id: 'A-1001', customer: 'R. Okonkwo', status: 'placed', placedAt: '2026-08-11T09:14:02Z', lines: [{ sku: 'SKU-COFFEE', quantity: 3, price: 6.17 }] },
  { id: 'A-1002', customer: 'M. Alvarez', status: 'picked', placedAt: '2026-08-11T09:02:47Z', lines: [{ sku: 'SKU-MUG', quantity: 1, price: 9.99 }] },
  { id: 'A-1003', customer: 'S. Nakamura', status: 'shipped', placedAt: '2026-08-11T08:51:19Z', lines: [{ sku: 'SKU-BEANS', quantity: 3, price: 4.05 }] },
  { id: 'A-1004', customer: 'T. Brennan', status: 'placed', placedAt: '2026-08-11T08:40:05Z', lines: [{ sku: 'SKU-COFFEE', quantity: 1, price: 6.17 }, { sku: 'SKU-FILTER', quantity: 2, price: 3.4 }] },
  { id: 'A-1005', customer: 'L. Fitzgerald', status: 'placed', placedAt: '2026-08-11T08:31:56Z', lines: [{ sku: 'SKU-MUG', quantity: 4, price: 9.99 }] },
  { id: 'A-1006', customer: 'D. Whitfield', status: 'picked', placedAt: '2026-08-11T08:20:00Z', lines: [{ sku: 'SKU-BEANS', quantity: 2, price: 4.05 }] },
  { id: 'A-1007', customer: 'K. Adeyemi', status: 'placed', placedAt: '2026-08-11T08:20:00Z', lines: [{ sku: 'SKU-COFFEE', quantity: 5, price: 6.17 }] },
  { id: 'A-1008', customer: 'P. Oyelaran', status: 'delivered', placedAt: '2026-08-10T17:44:31Z', lines: [{ sku: 'SKU-FILTER', quantity: 6, price: 3.4 }] },
  { id: 'A-1009', customer: 'H. Lindqvist', status: 'shipped', placedAt: '2026-08-10T16:12:08Z', lines: [{ sku: 'SKU-MUG', quantity: 2, price: 9.99 }, { sku: 'SKU-BEANS', quantity: 1, price: 4.05 }] },
  { id: 'A-1010', customer: 'J. Moreau', status: 'cancelled', placedAt: '2026-08-10T15:03:22Z', lines: [{ sku: 'SKU-COFFEE', quantity: 2, price: 6.17 }] },
  { id: 'A-1011', customer: 'B. Castellano', status: 'delivered', placedAt: '2026-08-10T11:38:54Z', lines: [{ sku: 'SKU-BEANS', quantity: 4, price: 4.05 }] },
  { id: 'A-1012', customer: 'N. Achebe', status: 'picked', placedAt: '2026-08-10T10:27:41Z', lines: [{ sku: 'SKU-FILTER', quantity: 1, price: 3.4 }] },
  { id: 'A-1013', customer: 'V. Sørensen', status: 'placed', placedAt: '2026-08-09T19:55:13Z', lines: [{ sku: 'SKU-MUG', quantity: 1, price: 9.99 }, { sku: 'SKU-COFFEE', quantity: 1, price: 6.17 }] },
  { id: 'A-1014', customer: 'G. Ferreira', status: 'delivered', placedAt: '2026-08-09T14:09:37Z', lines: [{ sku: 'SKU-BEANS', quantity: 6, price: 4.05 }] }
];

function catalogueEntry(sku) {
  return CATALOGUE[sku] || null;
}

function priceOf(sku) {
  var entry = catalogueEntry(sku);
  return entry ? entry.price : 0;
}

function nameOf(sku) {
  var entry = catalogueEntry(sku);
  return entry ? entry.name : sku;
}

function weightOf(sku) {
  var entry = catalogueEntry(sku);
  return entry ? entry.weightKg : 0;
}

function taxBandOf(sku) {
  var entry = catalogueEntry(sku);
  return entry ? entry.taxBand : 'zero';
}

function taxRateOf(sku) {
  var band = TAX_BANDS[taxBandOf(sku)];
  return typeof band === 'number' ? band : 0;
}

function boxVolumeCm3(sku) {
  var entry = catalogueEntry(sku);
  if (!entry || !entry.boxCm) return 0;
  return entry.boxCm.length * entry.boxCm.width * entry.boxCm.height;
}

function catalogueSkus() {
  var skus = [];
  for (var sku in CATALOGUE) {
    if (Object.prototype.hasOwnProperty.call(CATALOGUE, sku)) skus.push(sku);
  }
  skus.sort();
  return skus;
}

// The next id, derived from the largest one already on record rather than from the length of
// the list — orders are inserted at the front and cancelled ones are never removed, so a
// length-based id repeats itself the moment either of those happens.
function nextOrderId() {
  var highest = 1000;
  for (var i = 0; i < ORDERS.length; i += 1) {
    var suffix = Number(String(ORDERS[i].id).replace('A-', ''));
    if (!isNaN(suffix) && suffix > highest) highest = suffix;
  }
  return 'A-' + (highest + 1);
}

function nowIso() {
  return new Date().toISOString();
}
