// THE ORDER LIST — the table, the caption above it and the pager under it.
//
// `renderOrderList` asks the store for rows and renders every one it is given. The caption is
// computed from what was actually rendered against what the store holds, so it stays true
// whatever the store hands back.
//
// `renderPager` reports a count. There is nothing to page through, because the store returns
// the whole list.

function statusBadge(status) {
  return '<span class="status ' + status + '">' + status + '</span>';
}

function orderAmountCell(order) {
  var amounts = [];
  for (var i = 0; i < order.lines.length; i += 1) {
    amounts.push(lineTotal(order.lines[i]));
  }
  return formatPrice(sumAmounts(amounts));
}

function orderRow(order) {
  var lines = orderLineCount(order);

  return (
    '<tr data-order="' + order.id + '">' +
    '<td class="id">' + order.id + '</td>' +
    '<td>' + order.customer + '</td>' +
    '<td class="units">' + lines + ' ' + pluralise(lines, 'item', 'items') + '</td>' +
    '<td>' + statusBadge(order.status) + '</td>' +
    '<td class="amount">' + orderAmountCell(order) + '</td>' +
    '</tr>'
  );
}

function tableHead() {
  return (
    '<thead><tr><th>order</th><th>customer</th><th>items</th>' +
    '<th>status</th><th>total</th></tr></thead>'
  );
}

function emptyListMessage() {
  return '<p class="empty">There is nothing on this page.</p>';
}

// True whatever the store handed back: how many rows are on screen, out of how many exist.
function listCaption(rows) {
  var total = orderCount();
  return (
    '<p class="caption">showing ' + rows.length + ' of ' + total + ' ' +
    pluralise(total, 'order', 'orders') + '</p>'
  );
}

function renderOrderList(page) {
  var rows = allOrders();
  if (rows.length === 0) return emptyListMessage();

  var html = '';
  for (var i = 0; i < rows.length; i += 1) {
    html += orderRow(rows[i]);
  }

  return (
    listCaption(rows) +
    '<table class="orders">' + tableHead() + '<tbody>' + html + '</tbody></table>'
  );
}

function renderPager(page) {
  return '<p class="muted">' + allOrders().length + ' orders, all of them</p>';
}

// The rows one status accounts for, rendered as its own table. The status pane links into it.
function renderOrdersWithStatus(status) {
  var rows = ordersByStatus(status);
  if (rows.length === 0) return emptyListMessage();

  var html = '';
  for (var i = 0; i < rows.length; i += 1) {
    html += orderRow(rows[i]);
  }
  return '<table class="orders">' + tableHead() + '<tbody>' + html + '</tbody></table>';
}

// A one line summary of the whole list, for the header: how many orders are still moving and
// what they are worth.
function renderListSummary() {
  var open = openOrders();
  var amounts = [];
  for (var i = 0; i < open.length; i += 1) {
    amounts.push(orderSubtotal(open[i]));
  }

  return (
    '<p class="summary">' + open.length + ' ' + pluralise(open.length, 'order', 'orders') +
    ' still open, ' + formatPrice(sumAmounts(amounts)) + ' outstanding</p>'
  );
}

function renderStatusCounts() {
  var statuses = ['placed', 'picked', 'shipped', 'delivered', 'cancelled'];
  var html = '';
  for (var i = 0; i < statuses.length; i += 1) {
    var count = ordersByStatus(statuses[i]).length;
    if (count === 0) continue;
    html += '<li>' + statusBadge(statuses[i]) + ' <strong>' + count + '</strong></li>';
  }
  return '<ul class="status-counts">' + html + '</ul>';
}
