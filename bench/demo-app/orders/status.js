// THE STATUS PANEL — C2's other file.
//
// Baseline: there is nothing recorded to show, so the panel says so. C2 patches this file
// and `orders/repository.js`; keeping one without the other is a timeline that renders and
// stays empty, or a history that is recorded and never seen.

function renderStatusPanel(order) {
  return '<p class="empty">No status history is recorded for this order.</p>';
}
