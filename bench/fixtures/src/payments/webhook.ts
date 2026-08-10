// Inbound provider callbacks.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { updateOrderStatus } from '../orders/repository.js';

export async function handleWebhook(request: Request): Promise<Response> {
  const event = (await request.json()) as { type: string; reference: string };

  if (event.type === 'charge.succeeded') {
    await updateOrderStatus(event.reference, 'paid');
  }

  return new Response(null, { status: 204 });
}
