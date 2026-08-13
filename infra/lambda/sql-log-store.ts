/**
 * The show-SQL transcript's storage. `05` §5's `GET /demo/sql-log`.
 *
 * Stored where the connection registry is stored and for the same reason
 * (`docs/DECISIONS.md`): a run and the request that reads its transcript are two invocations and
 * possibly two sandboxes, and the transcript is bookkeeping with a lifetime of minutes rather
 * than memory. It is deliberately not a seventh table in `03` §2's model.
 *
 * **One installer rather than two.** Since U22 there are two functions that produce a transcript
 * — `demo.ts` for the four synchronous beats and `runner.ts` for the fleet run — and the second
 * copy of a TTL constant is where the two quietly stop agreeing about how long a panel keeps
 * working.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { useSqlLogStore, type SqlLogEntry } from '../../src/demo/sql-log.js';

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Outlives the session it describes by a margin, and no longer. */
const SQL_LOG_TTL_SECONDS = 2 * 60 * 60;

/**
 * Installs the store when `SQL_LOG_TABLE` is set, and does nothing when it is not.
 *
 * Silence is correct here: `src/demo/sql-log.ts` keeps an in-process fallback so that a local
 * caller and `test/` get a working transcript without DynamoDB, and a handler that threw on a
 * missing table would take the whole surface down over a panel.
 */
export function installSqlLogStore(): void {
  const table = process.env.SQL_LOG_TABLE;
  if (!table) return;

  useSqlLogStore({
    async put(entry) {
      await documents.send(
        new PutCommand({
          TableName: table,
          Item: { ...entry, expiresAt: Math.floor(Date.now() / 1000) + SQL_LOG_TTL_SECONDS },
        }),
      );
    },
    async get(sessionId) {
      const { Item } = await documents.send(new GetCommand({ TableName: table, Key: { sessionId } }));
      return (Item as SqlLogEntry | undefined) ?? null;
    },
  });
}
