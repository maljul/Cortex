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
 * All five of `05` §5's routes now exist. U14 built session, state and the stream; U16
 * added `POST /demo/run` and `GET /demo/sql-log`, which are the two that serve `07` §3's
 * beats and `07` §2's show-SQL toggle.
 */
import { StatementRecorder } from '../db/recorder.js';
import { createDemoSession, demoState } from '../memory/demo.js';
import { runScenario, type DemoArm } from './scenario.js';
import { readSqlLog, writeSqlLog } from './sql-log.js';

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

/**
 * How the scenario embeds its statements. Installed by the caller so this module carries
 * no Bedrock dependency and `test/` can drive the whole route surface deterministically.
 */
let embedderFn: ((text: string) => Promise<number[]>) | undefined;

export function useEmbedder(embed: (text: string) => Promise<number[]>): void {
  embedderFn = embed;
}

function embedder(): (text: string) => Promise<number[]> {
  if (!embedderFn) throw new Error('no embedder installed: call useEmbedder() at start-up');
  return embedderFn;
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

  // **Both the body and the query string, and the query half was missing until 2026-08-13.**
  //
  // `/check` found it blind (V40): this scanned `request.body` alone, while
  // `infra/lambda/demo.ts` parses every query parameter and passes it in — so on the deployed
  // API a credential on the query string was ignored and the request honoured with a 200.
  // Nothing leaked, because the parameter was dropped rather than stored. What failed is the
  // half of `05` §5 that matters most here: **"rejected rather than honoured"**, on a rule that
  // reads "in any field, under any name, on any path". A dropped credential looks, to whoever
  // pasted it, exactly like an accepted one — which is the docstring above this file's
  // `CREDENTIAL_KEY`, and it was true of this handler while it said so.
  //
  // Query first, because it is the half that was unguarded and a test that passes for the
  // wrong reason is easier to write against the second branch.
  //
  // **The path is deliberately not scanned.** A path names a route, not a field; the router
  // already answers anything it does not recognise with a 404, so a credential there reaches
  // no handler and is echoed nowhere.
  const offending =
    findCredentialField(request.query ?? null, ['query']) ?? findCredentialField(request.body ?? null);

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

  if (route === 'POST /demo/run') {
    const body = (request.body ?? {}) as { session?: unknown; arm?: unknown };
    const sessionId = typeof body.session === 'string' ? body.session : request.query?.['session'];
    if (!sessionId) {
      return json(400, { error: 'A session id is required. Start one at POST /demo/session.' });
    }

    // Only two values are accepted, and neither reaches SQL. `07` §4's honesty rule and
    // invariant 7 both point the same way: an arm is a fixed choice between two code
    // paths, not a parameter the caller gets to shape.
    const arm: DemoArm = body.arm === 'naive' ? 'naive' : 'cortex';

    if (!(await demoState(sessionId))) {
      return json(404, {
        error: 'That session has expired or never existed. Starting a new one is one click.',
      });
    }

    const recorder = new StatementRecorder();
    const result = await runScenario({
      sessionId,
      arm,
      embed: (text) => embedder()(text),
      recorder,
    });

    await writeSqlLog({
      sessionId,
      arm,
      recordedAt: new Date().toISOString(),
      statements: recorder.statements,
    });

    return json(200, {
      ...result,
      sql: { statements: recorder.statements.length, at: '/demo/sql-log' },
    });
  }

  if (route === 'GET /demo/sql-log') {
    const sessionId = request.query?.['session'];
    if (!sessionId) return json(400, { error: 'A session id is required.' });

    const log = await readSqlLog(sessionId);
    if (!log) {
      // Not an error: a session that has not run the scenario has executed no statements,
      // and an empty transcript is the truthful answer. `04` §5 invariant 1 forbids an
      // error page on any path a visitor can reach, and this is one click away.
      return json(200, { sessionId, arm: null, recordedAt: null, statements: [] });
    }

    return json(200, log);
  }

  return json(404, { error: 'No such route.' });
}
