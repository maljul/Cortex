/**
 * The changefeed ingress and the WebSocket fan-out. `04` §2, flow E.
 *
 * CockroachDB's webhook sink posts here; every connected browser that is listening to
 * the affected demo scope gets the row. `04` §2 puts EventBridge between the two for
 * consolidation, which is a different consumer of the same feed and is not built (`03`
 * §4.4); the live view does not need a bus to reach a socket, and adding one here would
 * have bought a second hop and a second failure mode for no behaviour.
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

const BUNDLE_REVISION = 2;

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

  for (const event_ of events) {
    const scope = scopeOf(event_);
    if (scope === null || !scopes.get(scope)) continue;

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
    }),
  );

  return { statusCode: 200, body: JSON.stringify({ delivered }) };
}
