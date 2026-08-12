/**
 * The changefeed ingress: the WebSocket fan-out (flow E) and consolidation (flow D).
 * `04` §2, `03` §4.4.
 *
 * CockroachDB's webhook sink posts here. Every connected browser listening to the
 * affected demo scope gets the row, and a row that is an intent reaching `done` also
 * becomes a durable finding.
 *
 * **`04` §2 routes flow D through EventBridge and this does not.** The bus buys
 * asynchrony this handler already has — the sink answers 200 regardless, and a
 * consolidation failure is caught and logged rather than retried — at the price of a
 * second hop and a second failure mode. What it would buy that matters is a *separate*
 * concurrency pool for the two consumers, and on an account where reserved concurrency
 * cannot be set at all (V26) there is no pool to separate. Recorded in
 * `docs/SPEC-DELTA.md` rather than left as a silent departure.
 *
 * There is a pleasing consequence worth knowing when reading beat 4: the finding this
 * handler inserts is itself a row change, so the changefeed delivers it back here and out
 * to the same socket a moment later. The judge watches memory improve over the same
 * stream that showed the work happening.
 *
 * **The sink must answer 200 for anything it accepted**, including a resolved message
 * and including a batch it decided to broadcast nothing from. A non-200 makes the
 * changefeed job retry and eventually fail, which takes the live panel down for a
 * reason that has nothing to do with the rows.
 */
import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

import {
  forTransport,
  isAuthorizedChangefeed,
  parseChangefeedPayload,
  scopeOf,
} from '../../src/demo/stream.js';
import { Embedder } from '../../src/embed/titan.js';
import { consolidateClosedIntent } from '../../src/memory/consolidate.js';
import { isLiveDemoScope } from '../../src/memory/demo.js';

interface HttpEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.CONNECTIONS_TABLE;
const CALLBACK_URL = process.env.WEBSOCKET_CALLBACK_URL;

const sockets = new ApiGatewayManagementApiClient(
  CALLBACK_URL ? { endpoint: CALLBACK_URL } : {},
);

const BUNDLE_REVISION = 3;

/**
 * Lazily built, like `getPool()` and for the same reason: a module-scope `Embedder` would
 * read `BEDROCK_REGION` before the handler's environment is in place. U8 hit exactly that
 * and it is why the MCP server's embedder is lazy too.
 */
let cachedEmbedder: Embedder | undefined;
function embedder(): Embedder {
  cachedEmbedder ??= new Embedder();
  return cachedEmbedder;
}

interface Connection {
  connectionId: string;
  sessionId: string | null;
}

async function listConnections(): Promise<Connection[]> {
  const { Items } = await documents.send(
    new ScanCommand({ TableName: TABLE, ProjectionExpression: 'connectionId, sessionId' }),
  );
  return (Items ?? []) as Connection[];
}

/** Posts to one socket, forgetting it if API Gateway says it is gone. */
async function push(connectionId: string, message: unknown): Promise<void> {
  try {
    await sockets.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      }),
    );
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 410) {
      await documents.send(new DeleteCommand({ TableName: TABLE, Key: { connectionId } }));
      return;
    }
    // One bad socket must not cost the rest of the batch its delivery.
    console.error(JSON.stringify({ level: 'error', connectionId, message: String(error) }));
  }
}

export async function handler(event: HttpEvent): Promise<{ statusCode: number; body: string }> {
  const presented = event.headers?.['authorization'] ?? event.headers?.['Authorization'];

  if (!isAuthorizedChangefeed(presented, process.env.CHANGEFEED_TOKEN)) {
    // The one route on this deployment that is not anonymous, and the one that must not
    // be: it is how rows get onto a panel that claims to be showing what committed.
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  if (!TABLE || !CALLBACK_URL) throw new Error('CONNECTIONS_TABLE / WEBSOCKET_CALLBACK_URL unset');

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  let decoded: unknown = null;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // Accepted and dropped. Retrying a body this sink cannot parse would not make it
    // parseable, and refusing it stalls the feed.
    return { statusCode: 200, body: JSON.stringify({ delivered: 0, reason: 'unparseable' }) };
  }

  const events = parseChangefeedPayload(decoded);
  if (events.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ delivered: 0 }) };
  }

  // Establish, once per distinct scope in the batch, whether it is a live demo scope.
  // The answer comes from the policy itself — see `isLiveDemoScope` — so a real
  // repository's rows are dropped here by the same predicate that keeps `cortex_demo`
  // off them at the write path.
  const scopes = new Map<string, boolean>();
  for (const scope of new Set(events.map(scopeOf).filter((s): s is string => s !== null))) {
    scopes.set(scope, await isLiveDemoScope(scope));
  }

  const connections = await listConnections();
  let delivered = 0;
  let consolidated = 0;

  for (const event_ of events) {
    const scope = scopeOf(event_);
    if (scope === null || !scopes.get(scope)) continue;

    // FLOW D — `04` §2, `03` §4.4. A closed intent becomes a durable finding, which is
    // beat 4 of `07` §3: the judge sees it *arrive over this same stream* a moment later,
    // because the insert below is itself a row change the changefeed will deliver.
    //
    // Wrapped rather than awaited into the delivery path: consolidation is off the
    // critical path by design, and a Bedrock hiccup must not stop the rows this batch is
    // already carrying from reaching the panel. The sink still answers 200 — see the
    // header — so a failure here costs one finding, not the feed.
    //
    // **The status test used to live here as well, and it is gone on purpose (U21).** This
    // handler read `status === 'done'` while `consolidateClosedIntent` applied the same rule
    // again — two copies of a memory-model decision, in two files, one of them deployed
    // separately from the other. When `abandoned` became consolidatable the copy here would
    // have silently vetoed it, and the unit test would still have passed, because the test
    // calls the function this handler was shadowing. `consolidate.ts` owns which transitions
    // deserve a finding and says so in its own header; this sink asks it rather than guessing.
    // `after` is null on a delete, which has no row to consolidate. That null check was
    // previously implicit in the status test this replaced.
    if (event_.topic === 'intents' && event_.after) {
      try {
        const result = await consolidateClosedIntent(event_.after, {
          embed: (text) => embedder().embed(text),
          plane: 'demo',
          demoSession: scope,
        });
        if (result) consolidated += 1;
      } catch (error) {
        console.error(
          JSON.stringify({ level: 'error', stage: 'consolidate', message: String(error) }),
        );
      }
    }

    const message = {
      type: 'change',
      topic: event_.topic,
      scope,
      after: forTransport(event_.after),
      ...(event_.updated ? { updated: event_.updated } : {}),
    };

    for (const connection of connections.filter((c) => c.sessionId === scope)) {
      await push(connection.connectionId, message);
      delivered += 1;
    }
  }

  console.log(
    JSON.stringify({
      level: 'info',
      bundleRevision: BUNDLE_REVISION,
      events: events.length,
      connections: connections.length,
      delivered,
      consolidated,
    }),
  );

  return { statusCode: 200, body: JSON.stringify({ delivered, consolidated }) };
}
