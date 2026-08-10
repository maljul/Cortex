// Card charging. Retries are not idempotent.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { providerRequest } from './provider.js';
import { PaymentFailed } from '../lib/errors.js';

export async function chargeCard(
  customerId: string,
  amountMinor: number,
  orderId: string,
): Promise<string> {
  const response = await providerRequest('/charges', {
    customer: customerId,
    amount: amountMinor,
    reference: orderId,
  });

  if (!response.ok) throw new PaymentFailed(`charge declined for ${orderId}`);

  const body = (await response.json()) as { id: string };
  return body.id;
}
