/**
 * Where the show-SQL panel's transcript lives between the run that produced it and the
 * request that fetches it. `05` §5's `GET /demo/sql-log`.
 *
 * `POST /demo/run` executes the statements; `GET /demo/sql-log` is a separate request, and
 * on Lambda that is a different invocation and possibly a different sandbox. So the
 * transcript has to be stored, and it is stored where the WebSocket connection registry is
 * stored and for the same reason: it is demo bookkeeping with a lifetime of minutes, not
 * memory, and `03` §2's six tables are the memory model. Reasoning in `docs/DECISIONS.md`.
 *
 * **The store is pluggable and defaults to memory**, so `test/` and `npm run` scripts
 * exercise the same routes without an AWS dependency. The Lambda installs a DynamoDB
 * backing at start-up. What must never differ between the two is the *content*: both hold
 * exactly the statements `StatementRecorder` observed going to the driver.
 */
import type { RecordedStatement } from '../db/recorder.js';

export interface SqlLogEntry {
  sessionId: string;
  arm: string;
  recordedAt: string;
  statements: RecordedStatement[];
}

export interface SqlLogStore {
  put(entry: SqlLogEntry): Promise<void>;
  get(sessionId: string): Promise<SqlLogEntry | null>;
}

/** The default: one process, one map. Correct for tests and for a single warm sandbox. */
class MemorySqlLogStore implements SqlLogStore {
  private readonly entries = new Map<string, SqlLogEntry>();

  async put(entry: SqlLogEntry): Promise<void> {
    this.entries.set(entry.sessionId, entry);
  }

  async get(sessionId: string): Promise<SqlLogEntry | null> {
    return this.entries.get(sessionId) ?? null;
  }
}

let store: SqlLogStore = new MemorySqlLogStore();

/** Installs a durable store. The demo Lambda calls this once, at module load. */
export function useSqlLogStore(replacement: SqlLogStore): void {
  store = replacement;
}

export async function writeSqlLog(entry: SqlLogEntry): Promise<void> {
  await store.put(entry);
}

export async function readSqlLog(sessionId: string): Promise<SqlLogEntry | null> {
  return store.get(sessionId);
}
