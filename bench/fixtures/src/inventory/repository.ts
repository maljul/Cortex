// Stock levels. Every read hits the database.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { pool } from '../db/pool.js';

export async function stockLevel(sku: string): Promise<number> {
  const { rows } = await pool.query('SELECT quantity FROM stock WHERE sku = $1', [sku]);
  return rows[0]?.quantity ?? 0;
}

export async function adjustStock(sku: string, delta: number): Promise<void> {
  await pool.query('UPDATE stock SET quantity = quantity + $2 WHERE sku = $1', [sku, delta]);
}
