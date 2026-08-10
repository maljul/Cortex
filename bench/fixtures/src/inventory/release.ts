// Returns reserved stock on cancellation.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { adjustStock } from './repository.js';
import type { OrderLine } from '../orders/validation.js';

export async function releaseStock(lines: OrderLine[]): Promise<void> {
  for (const line of lines) {
    await adjustStock(line.sku, line.quantity);
  }
}
