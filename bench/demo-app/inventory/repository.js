// STOCK — what is on the shelf, what is spoken for, and what a caller may still sell.
//
// Three numbers, and only the first of them is in `INVENTORY`:
//
//   * stock on record  — units physically on the shelf.
//   * reserved         — units on the shelf that a checkout in progress has already claimed.
//   * available        — on record minus reserved. This is the number a decision is made on.
//
// `stockOnRecord` is the raw read and it never lies about the shelf. `availableStock` is the
// answer to the question a caller usually means, and it is the one that has to stay right as
// this module grows.
//
// Reserving is deliberately two steps — read what is available, then write the reservation —
// because a single-threaded page has no way to make it one. Two checkouts interleaved between
// those steps both see the same availability and both reserve it; `reserveStock` returns the
// level it decided on so a caller can tell it apart from a level it read itself.

function isTracked(sku) {
  return Object.prototype.hasOwnProperty.call(INVENTORY, sku);
}

function stockOnRecord(sku) {
  return INVENTORY[sku] || 0;
}

function reservedFor(sku) {
  return RESERVATIONS[sku] || 0;
}

function availableStock(sku) {
  return stockOnRecord(sku) - reservedFor(sku);
}

function reserveStock(sku, quantity) {
  var seen = availableStock(sku);
  if (quantity <= 0) {
    return { ok: false, reason: 'a reservation must be for at least one unit', available: seen };
  }
  if (seen < quantity) {
    return { ok: false, reason: 'only ' + seen + ' available', available: seen };
  }

  RESERVATIONS[sku] = reservedFor(sku) + quantity;
  return { ok: true, reserved: quantity, available: seen };
}

function releaseReservation(sku, quantity) {
  var held = reservedFor(sku);
  var released = quantity > held ? held : quantity;
  RESERVATIONS[sku] = held - released;
  return released;
}

// Takes units off the shelf. A reservation covering them is released at the same time, or the
// units would be counted against the shelf twice — once as gone and once as spoken for.
function consumeStock(sku, quantity) {
  releaseReservation(sku, quantity);
  INVENTORY[sku] = stockOnRecord(sku) - quantity;
  return INVENTORY[sku];
}

function restock(sku, quantity) {
  INVENTORY[sku] = stockOnRecord(sku) + quantity;
  return INVENTORY[sku];
}

// A snapshot for anything that wants to render the whole shelf at once, sorted so two renders
// of an unchanged shelf produce the same markup.
function stockLevels() {
  var skus = catalogueSkus();
  var rows = [];
  for (var i = 0; i < skus.length; i += 1) {
    rows.push({
      sku: skus[i],
      name: nameOf(skus[i]),
      onRecord: stockOnRecord(skus[i]),
      reserved: reservedFor(skus[i]),
      available: availableStock(skus[i])
    });
  }
  return rows;
}

function lowStockSkus(threshold) {
  var limit = typeof threshold === 'number' ? threshold : 5;
  var rows = stockLevels();
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].available <= limit) out.push(rows[i].sku);
  }
  return out;
}

function isOversold(sku) {
  return stockOnRecord(sku) < 0;
}

function oversoldSkus() {
  var skus = catalogueSkus();
  var out = [];
  for (var i = 0; i < skus.length; i += 1) {
    if (isOversold(skus[i])) out.push(skus[i]);
  }
  return out;
}

// How many of a SKU an order asks for, across however many lines mention it.
function quantityWanted(order, sku) {
  var wanted = 0;
  for (var i = 0; i < order.lines.length; i += 1) {
    if (order.lines[i].sku === sku) wanted = wanted + order.lines[i].quantity;
  }
  return wanted;
}

function describeStock(sku) {
  var reserved = reservedFor(sku);
  var suffix = reserved > 0 ? ' (' + reserved + ' reserved)' : '';
  return nameOf(sku) + ' — ' + availableStock(sku) + ' available' + suffix;
}
