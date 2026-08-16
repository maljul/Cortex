// THE DASHBOARD — what a judge actually clicks.
//
// Loaded last, because it calls into every other module. It renders whatever those modules
// currently do and it is deliberately not defensive about what they return: if a quote comes
// back in one unit and the formatter expects another, this file renders the result of that.
//
// **No input elements anywhere.** Every action is a button carrying its arguments in data
// attributes — a judge with thirty seconds clicks and does not type.

var view = { page: 0, selected: null, lastResult: null, notice: null };

function el(id) {
  return document.getElementById(id);
}

function renderConfirmations(order) {
  if (!order) return '';

  var banners = confirmationsFor(order).slice();
  var body = confirmationBody(order);
  if (body) banners.push(body);
  if (banners.length === 0) return '';

  var html = '';
  for (var i = 0; i < banners.length; i += 1) {
    html += '<p class="banner">' + banners[i] + '</p>';
  }
  return html;
}

function renderTotals(order) {
  if (!order) return '';

  var items = orderSubtotal(order);
  var tax = taxForOrder(order);
  var shipping = shippingQuote(order);

  return (
    '<dl class="totals">' +
    '<dt>items</dt><dd>' + formatPrice(items) + '</dd>' +
    '<dt>tax</dt><dd>' + formatPrice(tax) + '</dd>' +
    '<dt>shipping</dt><dd>' + formatPrice(shipping) + '</dd>' +
    '<dt>total</dt><dd>' + formatPrice(items + tax + shipping) + '</dd>' +
    '</dl>' +
    '<p class="muted">' + describeParcel(order) + ', ' + deliveryEstimateDays(order) + ' working days</p>'
  );
}

function renderDetail() {
  var order = view.selected ? findOrder(view.selected) : null;
  if (!order) {
    return '<p class="empty">Pick an order to see its detail.</p>';
  }

  return (
    '<h3>' + order.id + ' · ' + order.customer + '</h3>' +
    renderConfirmations(order) +
    renderTotals(order) +
    statusPaneFor(order)
  );
}

function renderStock() {
  var rows = stockLevels();
  var html = '';
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var reserved = row.reserved > 0 ? ' <em>' + row.reserved + ' reserved</em>' : '';
    html +=
      '<li' + (row.onRecord < 0 ? ' class="negative"' : '') + '>' +
      row.name + ' — <strong>' + row.available + '</strong> available' + reserved + '</li>';
  }
  return '<ul class="stock">' + html + '</ul>';
}

var OFFERS = [
  { sku: 'SKU-COFFEE', quantity: 2 },
  { sku: 'SKU-MUG', quantity: 1 },
  { sku: 'SKU-FILTER', quantity: 4 }
];

function renderOrderButtons() {
  var html = '';
  for (var i = 0; i < OFFERS.length; i += 1) {
    var priced = quoteDraft({ customer: 'Walk-in', sku: OFFERS[i].sku, quantity: OFFERS[i].quantity });
    var cost = priced.ok ? ' · ' + formatPrice(priced.total) : '';
    html +=
      '<button class="order-new" data-sku="' + OFFERS[i].sku + '" data-qty="' + OFFERS[i].quantity + '">' +
      'order ' + OFFERS[i].quantity + ' × ' + nameOf(OFFERS[i].sku) + cost + '</button>';
  }
  return html;
}

function renderNotice() {
  if (view.notice) return '<p class="refused">' + view.notice + '</p>';
  if (!view.lastResult) return '';
  return (
    '<p class="' + (view.lastResult.ok ? 'ok' : 'refused') + '">' + view.lastResult.text + '</p>'
  );
}

function render() {
  el('summary').innerHTML = renderListSummary() + renderStatusCounts();
  el('list').innerHTML = renderOrderList(view.page) + renderPager(view.page);
  el('detail').innerHTML = renderDetail();
  el('stock').innerHTML = renderStock() + '<p class="muted">' + outboxSummary() + '</p>';
  el('actions').innerHTML = renderOrderButtons();
  el('result').innerHTML = renderNotice();
}

function selectOrder(id) {
  view.selected = id;
  view.notice = null;
  render();
}

function onStatusButton(target) {
  var id = target.getAttribute('data-id');
  var wanted = target.getAttribute('data-status');
  var updated = updateOrderStatus(id, wanted);

  view.selected = id;
  view.notice = updated
    ? null
    : 'That order cannot go straight to ' + wanted + ' from ' + findOrder(id).status + '.';
  render();
}

function onOrderButton(target) {
  var result = submitNewOrder({
    customer: 'Walk-in',
    sku: target.getAttribute('data-sku'),
    quantity: Number(target.getAttribute('data-qty'))
  });

  view.lastResult = { ok: result.ok === true, text: describeResult(result) };
  view.notice = null;
  if (result.ok) {
    view.selected = result.order.id;
    view.page = 0;
  }
  render();
}

function onClick(event) {
  var target = event.target;
  if (!target || target.nodeName !== 'BUTTON') {
    var row = target && target.closest ? target.closest('tr[data-order]') : null;
    if (row) selectOrder(row.getAttribute('data-order'));
    return;
  }

  // `classList`, not string equality: a pager marks the current page with a second class, and
  // an equality check would stop dispatching the moment that lands.
  if (target.classList.contains('status-set')) {
    onStatusButton(target);
    return;
  }

  if (target.classList.contains('order-new')) {
    onOrderButton(target);
    return;
  }

  if (target.classList.contains('page-set')) {
    view.page = Number(target.getAttribute('data-page'));
    view.notice = null;
    render();
  }
}

function start() {
  document.addEventListener('click', onClick);
  render();
}
