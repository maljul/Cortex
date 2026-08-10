// Sign-in endpoint. No throttling yet.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { verifyPassword } from './password.js';
import { createSession } from './session.js';
import { Unauthorized } from '../lib/errors.js';
import { findUserByEmail } from '../db/types.js';

export async function login(request: Request): Promise<Response> {
  const body = (await request.json()) as { email?: string; password?: string };

  if (!body.email || !body.password) {
    throw new Unauthorized('email and password are required');
  }

  const user = await findUserByEmail(body.email);
  if (!user) throw new Unauthorized('no such user');

  const ok = await verifyPassword(body.password, user.passwordHash);
  if (!ok) throw new Unauthorized('bad password');

  const session = await createSession(user.id);
  return Response.json({ token: session.token });
}
