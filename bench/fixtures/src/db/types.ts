// Row shapes.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import type { OrderLine } from '../orders/validation.js';

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

export interface Order {
  id: string;
  customerId: string;
  lines: OrderLine[];
  status: OrderStatus;
  totalMinor: number;
  placedAt: Date;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  void email;
  return undefined;
}
