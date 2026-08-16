// MONEY — how an amount is represented, and therefore what every other module has to agree
// with.
//
// An "amount" in this module is a number. Nothing in the type says which number: the
// catalogue writes prices as decimal pounds, and a carrier tariff, a tax rate and a stored
// total each have their own opinion about what a fraction of a penny means. The rules that
// hold today:
//
//   * `formatPrice` renders whatever it is handed, unchanged.
//   * `lineTotal` multiplies the price on the line by its quantity and rounds nothing, so
//     three lines at 6.17 come out of binary floating point as 18.509999999999998.
//   * `allocate` is the only function here that promises its parts add back up to the whole.
//
// `toMinorUnits` and `fromMinorUnits` exist and almost nothing calls them.

function formatPrice(amount) {
  return CURRENCY.symbol + amount;
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

// Half away from zero, which is what a customer expects and what banker's rounding is not.
// 2.345 rounds to 2.35 and -2.345 rounds to -2.35.
function roundPence(amount) {
  var scaled = amount * CURRENCY.minorUnitsPerUnit;
  var rounded = amount < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / CURRENCY.minorUnitsPerUnit;
}

function toMinorUnits(amount) {
  return Math.round(amount * CURRENCY.minorUnitsPerUnit);
}

function fromMinorUnits(minorUnits) {
  return minorUnits / CURRENCY.minorUnitsPerUnit;
}

function isWholeMinorUnits(amount) {
  return typeof amount === 'number' && isFinite(amount) && Math.floor(amount) === amount;
}

// A rate is a fraction — TAX_BANDS.standard is 0.2 and means twenty per cent. The result is
// rounded to two decimal places, which is the right thing to do to an amount in pounds and
// the wrong thing to do to an amount already counted in pennies.
function applyRate(amount, rate) {
  return roundPence(amount * rate);
}

function taxForLine(line) {
  return applyRate(lineTotal(line), taxRateOf(line.sku));
}

function taxForOrder(order) {
  var parts = [];
  for (var i = 0; i < order.lines.length; i += 1) {
    parts.push(taxForLine(order.lines[i]));
  }
  return sumAmounts(parts);
}

function orderSubtotal(order) {
  var parts = [];
  for (var i = 0; i < order.lines.length; i += 1) {
    parts.push(lineTotal(order.lines[i]));
  }
  return sumAmounts(parts);
}

// Splits an amount into `count` parts that add back up to it exactly.
//
// The naive answer — divide and round each part — loses or invents a penny on almost every
// input: a third of 10.00 is 3.33 three times over, which is 9.99. This hands the remainder
// out one minor unit at a time, earliest part first, so the parts differ by at most one
// minor unit and the sum is the amount that went in.
function allocate(amount, count) {
  if (count <= 0) return [];

  var totalMinor = toMinorUnits(amount);
  var negative = totalMinor < 0;
  var pool = negative ? -totalMinor : totalMinor;

  var base = Math.floor(pool / count);
  var remainder = pool - base * count;

  var parts = [];
  for (var i = 0; i < count; i += 1) {
    var share = base + (i < remainder ? 1 : 0);
    parts.push(fromMinorUnits(negative ? -share : share));
  }
  return parts;
}

// Splits an amount in proportion to a list of weights, with the same guarantee: the parts
// add back up to the amount. Weights that sum to zero fall back to an even split, because
// refusing would leave the caller with nothing to charge anybody.
function allocateByWeight(amount, weights) {
  var weightTotal = sumAmounts(weights);
  if (weightTotal === 0) return allocate(amount, weights.length);

  var totalMinor = toMinorUnits(amount);
  var parts = [];
  var handedOut = 0;

  for (var i = 0; i < weights.length; i += 1) {
    var exact = (totalMinor * weights[i]) / weightTotal;
    var floored = Math.floor(exact);
    parts.push({ index: i, minor: floored, fraction: exact - floored });
    handedOut = handedOut + floored;
  }

  var spare = totalMinor - handedOut;
  var ranked = parts.slice().sort(function (a, b) {
    if (b.fraction !== a.fraction) return b.fraction - a.fraction;
    return a.index - b.index;
  });
  for (var j = 0; j < spare; j += 1) {
    ranked[j % ranked.length].minor += 1;
  }

  var out = [];
  for (var k = 0; k < parts.length; k += 1) {
    out.push(fromMinorUnits(parts[k].minor));
  }
  return out;
}

function compareAmounts(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
