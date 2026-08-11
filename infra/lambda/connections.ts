/**
 * The WebSocket API's `$connect` and `$disconnect` routes. `04` §2's live memory stream.
 *
 * A WebSocket connection is a name the API Gateway hands out and a Lambda has to keep
 * somewhere in order to push to it later, so this pair does nothing but remember and
 * forget. It is deliberately not in CockroachDB: a connection id is deployment
 * bookkeeping with a lifetime of minutes, not memory, and `03` §2's six tables are the
 * memory model. Putting it there would also have meant a seventh table under
 * `cortex_demo`'s row-level security for something no policy has an opinion about.
 *
 * The `sessionId` is a query-string parameter the browser supplies. It is a *filter*,
 * not a permission: nothing here is trusted with a scope, because nothing here reads the
 * database. What a socket receives is decided in `changefeed.ts` from rows the cluster
 * itself emitted, and the confinement that matters is the one `04` §3 puts in front of
 * the write path.
 */
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

interface WebSocketEvent {
  requestContext: { connectionId: string; routeKey: string };
  queryStringParameters?: Record<string, string | undefined> | null;
}

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.CONNECTIONS_TABLE;

/**
 * How long a forgotten connection row survives. API Gateway closes an idle WebSocket
 * after ten minutes and a connection after two hours, so this is the outer bound plus
 * slack: DynamoDB's TTL sweep is not prompt, and the row is only ever a hint. A stale
 * one costs one failed post, which `changefeed.ts` cleans up on the spot.
 */
const CONNECTION_TTL_SECONDS = 3 * 60 * 60;

const BUNDLE_REVISION = 1;

export async function handler(event: WebSocketEvent): Promise<{ statusCode: number }> {
  if (!TABLE) throw new Error('CONNECTIONS_TABLE is not set');

  const { connectionId, routeKey } = event.requestContext;

  if (routeKey === '$connect') {
    await documents.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          connectionId,
          sessionId: event.queryStringParameters?.['session'] ?? null,
          bundleRevision: BUNDLE_REVISION,
          expiresAt: Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS,
        },
      }),
    );
    return { statusCode: 200 };
  }

  if (routeKey === '$disconnect') {
    await documents.send(new DeleteCommand({ TableName: TABLE, Key: { connectionId } }));
    return { statusCode: 200 };
  }

  // `$default` — the SPA never sends, it only listens. Accepting the frame and ignoring
  // it keeps the socket open, which is the behaviour a listener wants.
  return { statusCode: 200 };
}
