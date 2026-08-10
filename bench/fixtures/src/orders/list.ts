// Order listing. Returns everything, unpaginated.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { allOrders } from './repository.js';

export async function listOrders(request: Request): Promise<Response> {
  const customerId = new URL(request.url).searchParams.get('customer');
  const orders = await allOrders();

  const filtered = customerId
    ? orders.filter((order) => order.customerId === customerId)
    : orders;

  return Response.json({ orders: filtered, count: filtered.length });
}
