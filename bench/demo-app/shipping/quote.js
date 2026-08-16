// SHIPPING — what a parcel weighs for billing purposes, and what it costs.
//
// A carrier bills the greater of two weights: what the parcel actually weighs, and what its
// volume says it should weigh. A box of paper filters weighs fifty grams and takes a kilogram
// of space, and the carrier charges for the space. So `orderWeightKg` is the *billable*
// weight — the larger of the two — and it is the number a quote is built from.
//
// `SHIPPING_TARIFF` carries the base charge, the rate per kilogram and the divisor that turns
// centimetres cubed into kilograms. Nothing here decides what unit a charge is in; it decides
// what the charge is.
//
// Weights are rounded to three decimal places, once, at the end. Rounding per line and then
// summing gives a different parcel — for six light lines it differs by grams, and grams are
// exactly the width of a tariff band boundary.

function lineWeightKg(line) {
  return weightOf(line.sku) * line.quantity;
}

function lineVolumeCm3(line) {
  return boxVolumeCm3(line.sku) * line.quantity;
}

function roundKg(kg) {
  return Math.round(kg * 1000) / 1000;
}

function actualWeightKg(order) {
  var kg = 0;
  for (var i = 0; i < order.lines.length; i += 1) {
    kg = kg + lineWeightKg(order.lines[i]);
  }
  return roundKg(kg);
}

function volumetricWeightKg(order) {
  var cm3 = 0;
  for (var i = 0; i < order.lines.length; i += 1) {
    cm3 = cm3 + lineVolumeCm3(order.lines[i]);
  }
  return roundKg(cm3 / SHIPPING_TARIFF.volumetricDivisor);
}

// The billable weight, which is the one a quote is built from.
function orderWeightKg(order) {
  var actual = actualWeightKg(order);
  var volumetric = volumetricWeightKg(order);
  return actual > volumetric ? actual : volumetric;
}

function isVolumetric(order) {
  return volumetricWeightKg(order) > actualWeightKg(order);
}

function shippingQuote(order) {
  return 0;
}

// Two working days for anything on the shelf, three once a parcel is billed above five
// kilograms, because the heavy service runs on alternate days.
function deliveryEstimateDays(order) {
  return orderWeightKg(order) > 5 ? 3 : 2;
}

function formatWeight(kg) {
  if (kg < 1) return Math.round(kg * 1000) + 'g';
  return (Math.round(kg * 100) / 100) + 'kg';
}

// The line a judge reads in the detail pane: what the parcel weighs, and why that is the
// number it is.
function describeParcel(order) {
  var actual = actualWeightKg(order);
  var volumetric = volumetricWeightKg(order);
  if (volumetric > actual) {
    return formatWeight(volumetric) + ' billable (' + formatWeight(actual) + ' actual, charged by volume)';
  }
  return formatWeight(actual) + ' billable';
}

function heaviestLine(order) {
  var heaviest = null;
  for (var i = 0; i < order.lines.length; i += 1) {
    var kg = lineWeightKg(order.lines[i]);
    if (heaviest === null || kg > heaviest.kg) heaviest = { sku: order.lines[i].sku, kg: kg };
  }
  return heaviest;
}

// Shipping split across the lines of an order in proportion to what each one weighs, so a
// refund of one line takes its share of the carriage with it. The parts add back up to the
// quote exactly — `allocateByWeight` is where that guarantee lives.
function shippingPerLine(order) {
  var weights = [];
  for (var i = 0; i < order.lines.length; i += 1) {
    weights.push(lineWeightKg(order.lines[i]));
  }
  return allocateByWeight(shippingQuote(order), weights);
}
