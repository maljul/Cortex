/**
 * API Gateway HTTP adapter for the demo surface. `05` §5.
 *
 * Deliberately thin. Every decision this surface makes — which routes exist, what a
 * request may carry, what a reached limit looks like on the wire — is in
 * `src/demo/api.ts`, which has no AWS types in it and is therefore exercised against the
 * real cluster by `test/demo-plane.test.ts` rather than only after a deploy. This file
 * translates one event shape into another and does nothing else.
 *
 * The pool lives at module scope by way of `getPool('demo')`, so a warm sandbox reuses
 * its connection: V22 measured a cold query at ~690ms and a warm one at 3ms on exactly
 * that arrangement.
 */
import { handleDemoRequest } from '../../src/demo/api.js';

/** The subset of API Gateway's HTTP API v2 event this handler reads. */
interface HttpEvent {
  rawPath?: string;
  rawQueryString?: string;
  requestContext?: { http?: { method?: string; path?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Bumped by hand on each redeploy, as the identity handler's is. Without it a redeploy
 * and a no-op are indistinguishable from outside.
 */
const BUNDLE_REVISION = 1;

function decodeBody(event: HttpEvent): unknown {
  if (!event.body) return undefined;

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  if (raw.trim() === '') return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    // A body that is not JSON is not a route this surface serves. It is returned as a
    // refusal by the router below rather than thrown, because `04` §5 invariant 1 admits
    // no error page on any path a visitor can reach, and an unparseable body is a
    // visitor-reachable path.
    return { __unparseable: raw };
  }
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? event.requestContext?.http?.path ?? '/';

  const query: Record<string, string | undefined> = {};
  for (const [key, value] of new URLSearchParams(event.rawQueryString ?? '')) {
    query[key] = value;
  }

  try {
    const response = await handleDemoRequest({ method, path, query, body: decodeBody(event) });
    return {
      ...response,
      headers: { ...response.headers, 'x-cortex-bundle': String(BUNDLE_REVISION) },
    };
  } catch (error) {
    // The only 5xx this surface produces. A fault is not a limit: the degradation ladder
    // covers limits, and dressing a genuine failure up as a working page would
    // misrepresent liveness, which `04` §5 invariant 2 forbids just as firmly.
    const failure = error as { code?: string; message: string };
    console.error(JSON.stringify({ level: 'error', message: failure.message, code: failure.code }));

    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        error: 'The demo backend could not reach its database. Nothing here is live right now.',
      }),
    };
  }
}
