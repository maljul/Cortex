// Session records. Expiry is not enforced on read.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { newId } from '../lib/ids.js';
import { pool } from '../db/pool.js';

export interface Session {
  id: string;
  userId: string;
  token: string;
  createdAt: Date;
  lastSeenAt: Date;
}

export async function createSession(userId: string): Promise<Session> {
  const session: Session = {
    id: newId(),
    userId,
    token: newId(),
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };

  await pool.query(
    'INSERT INTO sessions (id, user_id, token, created_at, last_seen_at) VALUES ($1,$2,$3,$4,$5)',
    [session.id, session.userId, session.token, session.createdAt, session.lastSeenAt],
  );

  return session;
}

export async function findSession(token: string): Promise<Session | undefined> {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
  return rows[0];
}
