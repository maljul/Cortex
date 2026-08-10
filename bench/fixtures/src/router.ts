// Route table. One entry per public endpoint.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { createOrder } from './orders/create.js';
import { cancelOrder } from './orders/cancel.js';
import { listOrders } from './orders/list.js';
import { getOrder } from './orders/get.js';
import { login } from './auth/login.js';
import { requireSession } from './auth/middleware.js';
import { NotFound } from './lib/errors.js';

type Handler = (request: Request) => Promise<Response>;

const routes: Array<[string, string, Handler]> = [
  ['POST', '/auth/login', login],
  ['POST', '/orders', requireSession(createOrder)],
  ['GET', '/orders', requireSession(listOrders)],
  ['GET', '/orders/:id', requireSession(getOrder)],
  ['POST', '/orders/:id/cancel', requireSession(cancelOrder)],
];

export function createRouter() {
  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      for (const [method, pattern, handler] of routes) {
        if (request.method === method && matches(pattern, url.pathname)) {
          return handler(request);
        }
      }
      throw new NotFound(`no route for ${request.method} ${url.pathname}`);
    },
  };
}

function matches(pattern: string, path: string): boolean {
  const p = pattern.split('/');
  const q = path.split('/');
  if (p.length !== q.length) return false;
  return p.every((segment, i) => segment.startsWith(':') || segment === q[i]);
}
