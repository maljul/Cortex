// Refunds, issued by order reference.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { providerRequest } from './provider.js';
import { PaymentFailed } from '../lib/errors.js';

export async function refundCharge(orderId: string): Promise<void> {
  const response = await providerRequest('/refunds', { reference: orderId });
  if (!response.ok) throw new PaymentFailed(`refund failed for ${orderId}`);
}
