// Order creation. Does not check stock.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { insertOrder } from './repository.js';
import { validateOrderInput } from './validation.js';
import { reserveStock } from '../inventory/reserve.js';
import { chargeCard } from '../payments/charge.js';
import { newId } from '../lib/ids.js';

export async function createOrder(request: Request): Promise<Response> {
  const input = validateOrderInput(await request.json());

  const order = {
    id: newId(),
    customerId: input.customerId,
    lines: input.lines,
    status: 'pending' as const,
    totalMinor: input.lines.reduce((sum, line) => sum + line.priceMinor * line.quantity, 0),
    placedAt: new Date(),
  };

  await reserveStock(order.lines);
  await chargeCard(order.customerId, order.totalMinor, order.id);
  await insertOrder(order);

  return Response.json(order, { status: 201 });
}
