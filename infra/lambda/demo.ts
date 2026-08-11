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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { Embedder } from '../../src/embed/titan.js';
import { handleDemoRequest, useEmbedder } from '../../src/demo/api.js';
import { useSqlLogStore, type SqlLogEntry } from '../../src/demo/sql-log.js';

/**
 * The show-SQL transcript, stored where the connection registry is stored and for the
 * same reason (`docs/DECISIONS.md`): `POST /demo/run` and `GET /demo/sql-log` are two
 * invocations and possibly two sandboxes, and the transcript is bookkeeping with a
 * lifetime of minutes rather than memory.
 */
const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SQL_LOG_TABLE = process.env.SQL_LOG_TABLE;
/** Outlives the session it describes by a margin, and no longer. */
const SQL_LOG_TTL_SECONDS = 2 * 60 * 60;

if (SQL_LOG_TABLE) {
  useSqlLogStore({
    async put(entry) {
      await documents.send(
        new PutCommand({
          TableName: SQL_LOG_TABLE,
          Item: { ...entry, expiresAt: Math.floor(Date.now() / 1000) + SQL_LOG_TTL_SECONDS },
        }),
      );
    },
    async get(sessionId) {
      const { Item } = await documents.send(
        new GetCommand({ TableName: SQL_LOG_TABLE, Key: { sessionId } }),
      );
      return (Item as SqlLogEntry | undefined) ?? null;
    },
  });
}

// Lazily built, like `getPool()`: a module-scope `Embedder` would read `BEDROCK_REGION`
// before the handler's environment is in place. U8 hit exactly that.
let cachedEmbedder: Embedder | undefined;
useEmbedder(async (text) => {
  cachedEmbedder ??= new Embedder();
  return cachedEmbedder.embed(text);
});

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
const BUNDLE_REVISION = 2;

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
