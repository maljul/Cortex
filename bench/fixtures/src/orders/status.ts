// Order status transitions. History is not recorded.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import type { OrderStatus } from '../db/types.js';
import { Conflict } from '../lib/errors.js';

const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new Conflict(`cannot move an order from ${from} to ${to}`);
  }
}
