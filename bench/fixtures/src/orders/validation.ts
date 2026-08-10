// Input validation for order creation.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { BadRequest } from '../lib/errors.js';

export interface OrderLine {
  sku: string;
  quantity: number;
  priceMinor: number;
}

export interface OrderInput {
  customerId: string;
  lines: OrderLine[];
}

export function validateOrderInput(body: unknown): OrderInput {
  const input = body as Partial<OrderInput>;

  if (!input.customerId) throw new BadRequest('customerId is required');
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new BadRequest('at least one line is required');
  }

  for (const line of input.lines) {
    if (line.quantity <= 0) throw new BadRequest(`quantity must be positive for ${line.sku}`);
  }

  return input as OrderInput;
}
