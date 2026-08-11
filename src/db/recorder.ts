/**
 * Records the SQL this process actually executed, for `05` §5's `GET /demo/sql-log`.
 *
 * `07` §2 puts a "show SQL" toggle on the memory panel, and U16's named silent break is
 * that panel printing SQL the system did not run. A hand-written sample there is worse
 * than no panel at all: the panel exists to convert a visualisation into a proof, and a
 * plausible-looking fake inverts its entire purpose.
 *
 * So nothing here composes a statement. The recorder wraps a live `PoolClient` and writes
 * down what was handed to the driver, with the timing and row count the driver reported
 * back. A statement can only appear in the log by having been sent to CockroachDB.
 *
 * **Parameters are recorded as a count, never as values.** A demo session's parameters are
 * its own rows and would be harmless, but a recorder that logs values is one refactor away
 * from logging a DSN, and `05` §6 keeps every credential server side. The shape of a
 * parameterised query is what the panel is demonstrating — that no agent-controlled string
 * is ever concatenated into SQL — and `$1, $2` shows that better than the values would.
 */
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface RecordedStatement {
  /** The SQL as sent, whitespace collapsed so the panel can render it in one line. */
  sql: string;
  parameters: number;
  rows: number;
  ms: number;
}

/** Collapses the multi-line SQL this project writes into something a panel can show. */
function tidy(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ');
}

export class StatementRecorder {
  readonly statements: RecordedStatement[] = [];

  /**
   * Wraps a client so every `query` it runs is recorded.
   *
   * A Proxy rather than a subclass: `pg` hands out its own `PoolClient` instances and
   * `withRetry` passes one straight to the caller, so there is nothing to subclass without
   * changing what every existing call site receives. The transaction control statements
   * (`BEGIN`, `COMMIT`) run on this client too and are recorded like anything else, which
   * is the point — a judge reading the panel should see that the dedupe and the claim sit
   * inside one `BEGIN`, because that co-location is the project's whole thesis.
   */
  wrap(client: PoolClient): PoolClient {
    const recorder = this;

    return new Proxy(client, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver);

        return async function recordedQuery(
          this: unknown,
          config: string | { text: string },
          values?: unknown[],
        ): Promise<QueryResult<QueryResultRow>> {
          const sql = typeof config === 'string' ? config : config.text;
          const startedAt = Date.now();
          const result = (await (target.query as (...a: unknown[]) => Promise<QueryResult>).call(
            target,
            config,
            values,
          )) as QueryResult<QueryResultRow>;

          recorder.statements.push({
            sql: tidy(sql),
            parameters: values?.length ?? 0,
            rows: result.rowCount ?? 0,
            ms: Date.now() - startedAt,
          });

          return result;
        };
      },
    });
  }
}
