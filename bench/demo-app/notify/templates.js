// MESSAGE BODIES — the copy customers are sent, and the substitution that fills it in.
//
// A template is a string with `{{name}}` slots. `renderTemplate` fills them from a values
// object; a slot with no value is left as it is rather than rendered as `undefined`, so a
// missing field reads as an obvious gap in a proof rather than as a word in a sentence.
//
// `confirmationBody` is the one message the order flow asks for by name, and it returns
// nothing.

var BLANK = '';

var TEMPLATES = {
  shipped: 'Order {{id}} is on its way to {{customer}}. It should arrive in {{days}} working days.',
  cancelled: 'Order {{id}} has been cancelled. Nothing has been charged to {{customer}}.',
  refundManual: 'A refund for order {{id}} has been raised with our team and will be handled by hand.',
  lowStock: 'Only {{available}} of {{name}} remain.'
};

function renderTemplate(template, values) {
  var out = template;
  for (var key in values) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    var slot = '{{' + key + '}}';
    while (out.indexOf(slot) !== -1) {
      out = out.replace(slot, String(values[key]));
    }
  }
  return out;
}

function unfilledSlots(text) {
  var slots = [];
  var from = 0;
  while (true) {
    var open = text.indexOf('{{', from);
    if (open === -1) break;
    var close = text.indexOf('}}', open);
    if (close === -1) break;
    slots.push(text.slice(open + 2, close));
    from = close + 2;
  }
  return slots;
}

function pluralise(count, singular, plural) {
  return count === 1 ? singular : plural;
}

// Greedy word wrap. Words longer than the width are left whole on their own line rather than
// broken, because a broken SKU is unreadable and an over-long line is merely untidy.
function wrapAt(text, width) {
  var words = text.split(' ');
  var lines = [];
  var current = BLANK;

  for (var i = 0; i < words.length; i += 1) {
    if (current === BLANK) {
      current = words[i];
    } else if ((current + ' ' + words[i]).length <= width) {
      current = current + ' ' + words[i];
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  if (current !== BLANK) lines.push(current);
  return lines;
}

function lineDescription(line) {
  return line.quantity + ' × ' + nameOf(line.sku) + ' — ' + formatPrice(lineTotal(line));
}

function itemisation(order) {
  var parts = [];
  for (var i = 0; i < order.lines.length; i += 1) {
    parts.push(lineDescription(order.lines[i]));
  }
  return parts.join('; ');
}

function subjectFor(order, kind) {
  if (kind === 'shipped') return 'Order ' + order.id + ' has shipped';
  if (kind === 'cancelled') return 'Order ' + order.id + ' was cancelled';
  return 'Order ' + order.id;
}

function confirmationBody(order) {
  return '';
}

function shippedBody(order) {
  return renderTemplate(TEMPLATES.shipped, {
    id: order.id,
    customer: order.customer,
    days: deliveryEstimateDays(order)
  });
}

function cancelledBody(order) {
  return renderTemplate(TEMPLATES.cancelled, { id: order.id, customer: order.customer });
}

function refundBody(order) {
  return renderTemplate(TEMPLATES.refundManual, { id: order.id });
}

function lowStockBody(sku) {
  return renderTemplate(TEMPLATES.lowStock, {
    available: availableStock(sku),
    name: nameOf(sku)
  });
}

function bodyFor(order, kind) {
  if (kind === 'shipped') return shippedBody(order);
  if (kind === 'cancelled') return cancelledBody(order);
  if (kind === 'refund') return refundBody(order);
  return confirmationBody(order);
}
