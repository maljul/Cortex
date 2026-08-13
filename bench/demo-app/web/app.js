// THE DASHBOARD — what a judge actually clicks.
//
// Loaded last, because it calls into every other module. It renders whatever those modules
// currently do, and it is deliberately *not* defensive about what they return: if
// `shippingQuote` hands back pounds to a `formatPrice` that expects minor units, this file
// renders the result of that, which is the point.
//
// **No input elements anywhere.** Every action is a button carrying its arguments in data
// attributes. That is partly `02` B3's habit — the demo surface contains no field of any kind
// — and partly that a judge with thirty seconds clicks and does not type.

var view = { page: 0, selected: null, lastResult: null };

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

  var amounts = [];
  for (var i = 0; i < order.lines.length; i += 1) {
    amounts.push(lineTotal(order.lines[i]));
  }
  var items = sumAmounts(amounts);
  var shipping = shippingQuote(order);

  return (
    '<dl class="totals">' +
    '<dt>items</dt><dd>' + formatPrice(items) + '</dd>' +
    '<dt>shipping</dt><dd>' + formatPrice(shipping) + '</dd>' +
    '<dt>total</dt><dd>' + formatPrice(items + shipping) + '</dd>' +
    '</dl>'
  );
}

function renderDetail() {
  var order = view.selected ? findOrder(view.selected) : null;
  if (!order) {
    return '<p class="empty">Pick an order to see its detail.</p>';
  }

  var buttons = '';
  var statuses = ['placed', 'picked', 'shipped'];
  for (var i = 0; i < statuses.length; i += 1) {
    buttons +=
      '<button class="status-set" data-id="' + order.id + '" data-status="' + statuses[i] + '">' +
      'mark ' + statuses[i] + '</button>';
  }

  return (
    '<h3>' + order.id + ' · ' + order.customer + '</h3>' +
    renderConfirmations(order) +
    renderTotals(order) +
    '<div class="row">' + buttons + '</div>' +
    renderStatusPanel(order)
  );
}

function renderStock() {
  var skus = ['SKU-COFFEE', 'SKU-MUG', 'SKU-BEANS'];
  var html = '';
  for (var i = 0; i < skus.length; i += 1) {
    var level = stockOnRecord(skus[i]);
    html +=
      '<li' + (level < 0 ? ' class="negative"' : '') + '>' +
      nameOf(skus[i]) + ' — <strong>' + level + '</strong> in stock</li>';
  }
  return '<ul class="stock">' + html + '</ul>';
}

function renderOrderButtons() {
  var html = '';
  var offers = [
    { sku: 'SKU-COFFEE', quantity: 2 },
    { sku: 'SKU-MUG', quantity: 1 },
  ];
  for (var i = 0; i < offers.length; i += 1) {
    html +=
      '<button class="order-new" data-sku="' + offers[i].sku + '" data-qty="' + offers[i].quantity + '">' +
      'order ' + offers[i].quantity + ' × ' + nameOf(offers[i].sku) + '</button>';
  }
  return html;
}

function render() {
  el('list').innerHTML = renderOrderList(view.page) + renderPager(view.page);
  el('detail').innerHTML = renderDetail();
  el('stock').innerHTML = renderStock();
  el('actions').innerHTML = renderOrderButtons();
  el('result').innerHTML = view.lastResult
    ? '<p class="' + (view.lastResult.ok ? 'ok' : 'refused') + '">' + view.lastResult.text + '</p>'
    : '';
}

function onClick(event) {
  var target = event.target;
  if (!target || target.nodeName !== 'BUTTON') {
    var row = target && target.closest ? target.closest('tr[data-order]') : null;
    if (row) {
      view.selected = row.getAttribute('data-order');
      render();
    }
    return;
  }

  // `classList`, not string equality: C1's pager marks the current page with a second class,
  // and an equality check would stop dispatching the moment that ticket lands.
  if (target.classList.contains('status-set')) {
    updateOrderStatus(target.getAttribute('data-id'), target.getAttribute('data-status'));
    view.selected = target.getAttribute('data-id');
    render();
    return;
  }

  if (target.classList.contains('order-new')) {
    var result = submitNewOrder({
      customer: 'Walk-in',
      sku: target.getAttribute('data-sku'),
      quantity: Number(target.getAttribute('data-qty')),
    });
    view.lastResult = result.ok
      ? { ok: true, text: 'Order ' + result.order.id + ' placed.' }
      : { ok: false, text: 'Refused: ' + result.reason };
    if (result.ok) view.selected = result.order.id;
    view.page = 0;
    render();
    return;
  }

  if (target.classList.contains('page-set')) {
    view.page = Number(target.getAttribute('data-page'));
    render();
  }
}

function start() {
  document.addEventListener('click', onClick);
  render();
}
