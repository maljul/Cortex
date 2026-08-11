/**
 * THE DEMO HTTP SURFACE — spec/05-INTERFACES.md §5.
 *
 * Public, anonymous, and reachable by anyone on the internet with no account. That is a
 * rules requirement (B4) rather than a convenience, and it is why this file is mostly
 * about what it refuses.
 *
 * Deliberately free of AWS types. API Gateway's event shape is adapted in
 * `infra/lambda/demo.ts`; everything decided here — which routes exist, what a request
 * may carry, what a limit looks like on the wire — is decided in a function that
 * `test/demo-plane.test.ts` can call directly against the real cluster. A route surface
 * that can only be exercised after it is deployed is a route surface that is exercised
 * once.
 *
 * **Two routes, not five.** `05` §5 specifies five; `POST /demo/run` and
 * `GET /demo/sql-log` serve the four beats of `07` §3 and arrive with the SPA that
 * renders them (U16), and the replay/live mode they carry is the degradation ladder's
 * (U17). U14 is the deployed surface and the change stream. `05` §5 is listed by U14 and
 * U16 both, and this is where the line falls.
 */
import { createDemoSession, demoState } from '../memory/demo.js';

export interface DemoRequest {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface DemoResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Field names that look like a credential.
 *
 * `05` §5 forbids one "in any field, under any name, on any path", and requires a
 * request carrying one to be **rejected rather than honoured** — ignoring it is not
 * enough, because the rule exists so that the field never appears to work. The moment a
 * `dsn` field appears to work, somebody pastes a live connection string into a
 * stranger's web form.
 *
 * `session` is not here and must not be: a session id is a public, ephemeral, scoped
 * identifier that the server minted and the browser is expected to send back. `auth`,
 * `token` and `arn` are, including nested, which is why the scan below recurses.
 */
const CREDENTIAL_KEY = /(dsn|conn(ection)?[_-]?string|passw(or)?d|secret|token|bearer|auth|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|arn|role)/i;

/**
 * Values that look like a credential whatever they are called. A visitor who names the
 * field `note` and pastes a connection string into it is the same failure as a `dsn`
 * field, and the same refusal.
 */
const CREDENTIAL_VALUE = /(postgres(ql)?:\/\/|sslmode=|\bsk-[a-z0-9]|\bAKIA[0-9A-Z]{8}|arn:aws:)/i;

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  // The SPA is served from CloudFront and this API from API Gateway, so every call the
  // browser makes is cross-origin. Anonymous and unauthenticated by design: there is no
  // cookie, no session credential and nothing to protect with an origin check.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  // A demo panel that renders a cached session's state is showing something that is not
  // true any more, which `04` §5 invariant 2 is about.
  'cache-control': 'no-store',
};

function json(statusCode: number, payload: unknown): DemoResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

/** Walks a decoded request body looking for anything credential-shaped, at any depth. */
export function findCredentialField(value: unknown, path: string[] = []): string | null {
  if (typeof value === 'string' && CREDENTIAL_VALUE.test(value)) {
    return path.join('.') || '<body>';
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findCredentialField(item, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) return [...path, key].join('.');
      const found = findCredentialField(item, [...path, key]);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Routes one request. Never throws for a limit or a missing session — `04` §5 invariant
 * 1 admits no error page on any path a visitor can reach, so an expired or unknown
 * session is a 404 carrying an explanation the SPA can render, and a genuine fault is
 * the only 5xx.
 */
export async function handleDemoRequest(request: DemoRequest): Promise<DemoResponse> {
  if (request.method === 'OPTIONS') {
    return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  }

  const offending = findCredentialField(request.body ?? null);
  if (offending) {
    return json(400, {
      error:
        'This demo never accepts a credential. No route takes a connection string, key, ' +
        'token or role, and the field carrying one was refused rather than ignored.',
      field: offending,
    });
  }

  const route = `${request.method} ${request.path}`;

  if (route === 'POST /demo/session') {
    const session = await createDemoSession();
    return json(200, {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
    });
  }

  if (route === 'GET /demo/state') {
    const sessionId = request.query?.['session'];
    if (!sessionId) {
      return json(400, { error: 'A session id is required. Start one at POST /demo/session.' });
    }

    const state = await demoState(sessionId);
    if (!state) {
      return json(404, {
        error: 'That session has expired or never existed. Starting a new one is one click.',
      });
    }

    return json(200, state);
  }

  return json(404, { error: 'No such route.' });
}
