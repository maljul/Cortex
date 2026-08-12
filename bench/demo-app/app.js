// The dashboard. THE CONTENDED FILE — C1, C2 and C3 all edit this one.
//
// Three separate regions, three separate features, no textual overlap between them:
//   renderList    -> C1 adds pagination
//   renderDetail  -> C2 adds the status timeline
//   submitOrder   -> C3 adds the stock check
//
// Any merge tool would take all three without complaint. What loses two of them in the naive
// lane is last-write-wins on the whole file: each agent read this before the others wrote.

var selectedId = ORDERS[0].id;
var banner = '';

function renderList() {
  var rows = ORDERS.map(function (order) {
    return (
      '<tr class="' + (order.id === selectedId ? 'on' : '') + '" data-id="' + order.id + '">' +
      '<td>' + order.id + '</td>' +
      '<td>' + order.customer + '</td>' +
      '<td><span class="pill">' + order.status + '</span></td>' +
      '<td class="num">' + formatPrice(orderTotal(order)) + '</td>' +
      '</tr>'
    );
  });

  return (
    '<table><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead>' +
    '<tbody>' + rows.join('') + '</tbody></table>'
  );
}

function renderDetail() {
  var order = ORDERS.filter(function (o) { return o.id === selectedId; })[0];
  if (!order) return '<p class="muted">No order selected.</p>';

  var lines = order.lines.map(function (line) {
    return (
      '<li>' + line.quantity + ' &times; ' + line.sku +
      ' <span class="num">' + formatPrice(lineTotal(line)) + '</span></li>'
    );
  });

  return (
    '<h3>' + order.id + '</h3>' +
    '<p class="muted">' + order.customer + '</p>' +
    '<ul class="lines">' + lines.join('') + '</ul>' +
    '<h4>Status history</h4>' +
    '<p class="muted" id="timeline">No history recorded.</p>'
  );
}

function submitOrder(sku, quantity) {
  var order = {
    id: 'A-' + (1007 + ORDERS.length - 6),
    customer: 'New customer',
    status: 'placed',
    lines: [{ sku: sku, quantity: quantity, price: 6.17 }],
  };

  ORDERS.push(order);
  notifyOrderPlaced(order);
  selectedId = order.id;
  return order;
}

function renderBanner() {
  return banner ? '<div class="banner">' + banner + '</div>' : '';
}

function render() {
  document.getElementById('banner').innerHTML = renderBanner();
  document.getElementById('list').innerHTML = renderList();
  document.getElementById('detail').innerHTML = renderDetail();

  var rows = document.querySelectorAll('#list tr[data-id]');
  for (var i = 0; i < rows.length; i++) {
    rows[i].onclick = function () {
      selectedId = this.getAttribute('data-id');
      render();
    };
  }
}

function start() {
  document.getElementById('place').onclick = function () {
    var sku = document.getElementById('sku').value;
    var quantity = parseInt(document.getElementById('qty').value, 10) || 1;
    try {
      submitOrder(sku, quantity);
    } catch (error) {
      banner = '<strong>Refused.</strong> ' + error.message;
      render();
      return;
    }
    render();
  };
  render();
}
