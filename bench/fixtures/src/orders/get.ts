// Single order lookup.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { findOrder } from './repository.js';
import { NotFound } from '../lib/errors.js';

export async function getOrder(request: Request): Promise<Response> {
  const id = new URL(request.url).pathname.split('/')[2] ?? '';
  const order = await findOrder(id);
  if (!order) throw new NotFound(`no order ${id}`);
  return Response.json(order);
}
