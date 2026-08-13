// STOCK LEVELS — the other half of interlock 2.
//
// Baseline: every lookup reads the record. P2 is the ticket that puts a thirty second cache
// in front of `availableStock`, which is a correct and ordinary thing to do.
//
// `stockOnRecord` exists in the baseline and P2 does not touch it. That matters: it is the
// uncached read an agent that *knows about the cache* can reach for, and an agent that does
// not know will use `availableStock` like everything else. Both are correct in isolation.

function stockOnRecord(sku) {
  return INVENTORY[sku] || 0;
}

function availableStock(sku) {
  return stockOnRecord(sku);
}

function consumeStock(sku, quantity) {
  INVENTORY[sku] = stockOnRecord(sku) - quantity;
}
