// THE STATUS PANE — where an order is, what it may do next, and what it has already done.
//
// The first two come from the store and the flow table. The third would come from
// `statusHistory`, and there is nothing in it, so the pane says so.

var STATUS_LABELS = {
  placed: 'placed',
  picked: 'picked and packed',
  shipped: 'with the carrier',
  delivered: 'delivered',
  cancelled: 'cancelled'
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

// Whole units, largest that fits, because "2 days ago" is what a reader wants and
// "2 days 4 hours 11 minutes ago" is what a clock wants.
function elapsedSince(iso) {
  var then = Date.parse(iso);
  if (isNaN(then)) return 'at an unknown time';

  var seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';

  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' ' + pluralise(minutes, 'minute', 'minutes') + ' ago';

  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' ' + pluralise(hours, 'hour', 'hours') + ' ago';

  var days = Math.floor(hours / 24);
  return days + ' ' + pluralise(days, 'day', 'days') + ' ago';
}

function clockOf(iso) {
  return String(iso).slice(11, 19);
}

// How far along the ranked stages an order is, as a fraction. `cancelled` is outside the
// ranking, so it reports nothing rather than reporting zero — an order that was cancelled
// after it shipped did not go backwards.
function statusProgress(status) {
  var rank = STATUS_RANK[status];
  if (typeof rank !== 'number') return null;

  var stages = 0;
  for (var key in STATUS_RANK) {
    if (Object.prototype.hasOwnProperty.call(STATUS_RANK, key)) stages += 1;
  }
  return rank / (stages - 1);
}

function renderProgress(order) {
  var progress = statusProgress(order.status);
  if (progress === null) {
    return '<p class="muted">' + statusLabel(order.status) + '</p>';
  }
  return (
    '<p class="progress"><span style="width:' + Math.round(progress * 100) + '%"></span></p>' +
    '<p class="muted">' + statusLabel(order.status) + '</p>'
  );
}

function renderStatusActions(order) {
  var onward = nextStatusesFor(order);
  if (onward.length === 0) {
    return '<p class="muted">' + statusLabel(order.status) + ' is the end of the road.</p>';
  }

  var html = '';
  for (var i = 0; i < onward.length; i += 1) {
    html +=
      '<button class="status-set" data-id="' + order.id + '" data-status="' + onward[i] + '">' +
      'mark ' + onward[i] + '</button>';
  }
  return '<div class="row">' + html + '</div>';
}

function renderStatusPanel(order) {
  return '<p class="empty">No status history is recorded for this order.</p>';
}

// What the pane shows above the history: where the order is now, and where it may go.
function renderStatusHeader(order) {
  return (
    '<p class="placed">placed ' + elapsedSince(order.placedAt) + '</p>' +
    renderProgress(order) +
    renderStatusActions(order)
  );
}

function statusPaneFor(order) {
  return renderStatusHeader(order) + renderStatusPanel(order);
}
