// Schema migrations, applied by hand today.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export const migrations: string[] = [
  'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT)',
  'CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, token TEXT, created_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ)',
  'CREATE TABLE orders (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT, total_minor BIGINT, placed_at TIMESTAMPTZ)',
  'CREATE TABLE order_lines (order_id TEXT, sku TEXT, quantity INT, price_minor BIGINT)',
  'CREATE TABLE stock (sku TEXT PRIMARY KEY, quantity INT)',
];
