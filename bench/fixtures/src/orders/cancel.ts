// Cancellation. There is currently no time window.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { findOrder, updateOrderStatus } from './repository.js';
import { releaseStock } from '../inventory/release.js';
import { refundCharge } from '../payments/refund.js';
import { NotFound, Conflict } from '../lib/errors.js';

export async function cancelOrder(request: Request): Promise<Response> {
  const id = new URL(request.url).pathname.split('/')[2] ?? '';
  const order = await findOrder(id);

  if (!order) throw new NotFound(`no order ${id}`);
  if (order.status === 'shipped') throw new Conflict('shipped orders cannot be cancelled');

  await releaseStock(order.lines);
  await refundCharge(order.id);
  await updateOrderStatus(order.id, 'cancelled');

  return Response.json({ id: order.id, status: 'cancelled' });
}
