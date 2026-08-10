// Wraps a handler so it only runs for a signed-in caller.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { findSession } from './session.js';
import { Unauthorized } from '../lib/errors.js';

type Handler = (request: Request) => Promise<Response>;

export function requireSession(handler: Handler): Handler {
  return async (request: Request) => {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) throw new Unauthorized('missing bearer token');

    const session = await findSession(header.slice('Bearer '.length));
    if (!session) throw new Unauthorized('unknown session');

    return handler(request);
  };
}
