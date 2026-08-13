// THE ORDER LIST VIEW — C1's other file.
//
// Baseline: it asks the store for everything and renders the lot, and `renderPager` returns
// nothing because there is nothing to page. C1 patches both this file and
// `orders/repository.js`, which is why a lane that keeps one and loses the other shows a
// pager that does not page.

function orderRow(order) {
  var amounts = [];
  for (var i = 0; i < order.lines.length; i += 1) {
    amounts.push(lineTotal(order.lines[i]));
  }

  return (
    '<tr data-order="' + order.id + '">' +
    '<td class="id">' + order.id + '</td>' +
    '<td>' + order.customer + '</td>' +
    '<td><span class="status ' + order.status + '">' + order.status + '</span></td>' +
    '<td class="amount">' + formatPrice(sumAmounts(amounts)) + '</td>' +
    '</tr>'
  );
}

function renderOrderList(page) {
  var rows = allOrders();
  var html = '';
  for (var i = 0; i < rows.length; i += 1) {
    html += orderRow(rows[i]);
  }

  return (
    '<table class="orders"><thead><tr><th>order</th><th>customer</th>' +
    '<th>status</th><th>total</th></tr></thead><tbody>' + html + '</tbody></table>'
  );
}

function renderPager(page) {
  return '<p class="muted">' + allOrders().length + ' orders, all of them</p>';
}
