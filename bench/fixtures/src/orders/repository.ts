// All order persistence. The busiest file in the service.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { pool } from '../db/pool.js';
import type { Order, OrderStatus } from '../db/types.js';

export async function insertOrder(order: Order): Promise<void> {
  await pool.query(
    'INSERT INTO orders (id, customer_id, status, total_minor, placed_at) VALUES ($1,$2,$3,$4,$5)',
    [order.id, order.customerId, order.status, order.totalMinor, order.placedAt],
  );

  for (const line of order.lines) {
    await pool.query(
      'INSERT INTO order_lines (order_id, sku, quantity, price_minor) VALUES ($1,$2,$3,$4)',
      [order.id, line.sku, line.quantity, line.priceMinor],
    );
  }
}

export async function findOrder(id: string): Promise<Order | undefined> {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0];
}

export async function allOrders(): Promise<Order[]> {
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY placed_at DESC');
  return rows;
}

export async function updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
  await pool.query('UPDATE orders SET status = $2 WHERE id = $1', [id, status]);
}
