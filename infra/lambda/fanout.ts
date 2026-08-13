/**
 * THE SOCKET FAN-OUT — one implementation, two producers.
 *
 * Everything a browser sees on the live panel goes out through here: the cluster's own changefeed
 * rows (`changefeed.ts`, flow E) and, since U22, the fleet events a run emits as it happens
 * (`runner.ts`). This file exists because those are two Lambdas and the alternative was two copies
 * of "scan the connection table, post, forget the ones API Gateway says are gone" — and the second
 * copy is where the 410 handling quietly stops matching.
 *
 * **It knows nothing about what it is delivering.** No message is built here, and none is edited
 * on the way through. `src/demo/stream.ts` says why for changefeed rows — flow E's claim is that
 * the panel shows what committed — and design §5.3 says why for fleet events: the two sources are
 * labelled differently, so the labelling has to be decided by whoever produced the message rather
 * than by the pipe both of them share.
 *
 * Kept in `infra/lambda/` rather than `src/` deliberately, and it is the one piece of the delivery
 * path that could not be moved: it is DynamoDB and API Gateway's management API and nothing else.
 */
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.CONNECTIONS_TABLE;
const CALLBACK_URL = process.env.WEBSOCKET_CALLBACK_URL;

const sockets = new ApiGatewayManagementApiClient(CALLBACK_URL ? { endpoint: CALLBACK_URL } : {});

export interface Connection {
  connectionId: string;
  sessionId: string | null;
}

/** Throws with the missing variable named, rather than failing later as an empty scan. */
export function requireFanoutEnvironment(): void {
  if (!TABLE || !CALLBACK_URL) throw new Error('CONNECTIONS_TABLE / WEBSOCKET_CALLBACK_URL unset');
}

export async function listConnections(): Promise<Connection[]> {
  const { Items } = await documents.send(
    new ScanCommand({ TableName: TABLE, ProjectionExpression: 'connectionId, sessionId' }),
  );
  return (Items ?? []) as Connection[];
}

/**
 * Posts to one socket, forgetting it if API Gateway says it is gone.
 *
 * Returns whether the message was delivered. A caller that needs to report how much of a run
 * reached the page — `src/demo/run.ts` does, on its terminal message — cannot get that from a
 * function that swallows the answer.
 */
export async function push(connectionId: string, message: unknown): Promise<boolean> {
  try {
    await sockets.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      }),
    );
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 410) {
      await documents.send(new DeleteCommand({ TableName: TABLE, Key: { connectionId } }));
      return false;
    }
    // One bad socket must not cost the rest of the batch its delivery.
    console.error(JSON.stringify({ level: 'error', connectionId, message: String(error) }));
    return false;
  }
}

/**
 * Sends one message to every connection listening on any of `scopes`.
 *
 * **Any of, and that is a consequence of design §4.1 rather than convenience.** A visitor now has
 * two scopes, one per arm, but a WebSocket connection registers exactly one `session` query
 * parameter — so a run's events belong to two scopes and a listener has subscribed to one of them.
 * Broadcasting to both is what lets a page hold one socket and watch the whole run. It grants
 * nothing: a fleet event is not a row, it is scoped by the run that produced it, and every real
 * row still goes out through `changefeed.ts`'s per-scope match against what the cluster emitted.
 *
 * Returns the number of sockets it reached, which is zero when nobody is listening — the ordinary
 * case for a run nobody has opened the page for, and not an error.
 */
export async function broadcast(scopes: readonly string[], message: unknown): Promise<number> {
  const wanted = new Set(scopes);
  const connections = await listConnections();

  let delivered = 0;
  for (const connection of connections) {
    if (connection.sessionId === null || !wanted.has(connection.sessionId)) continue;
    if (await push(connection.connectionId, message)) delivered += 1;
  }
  return delivered;
}
