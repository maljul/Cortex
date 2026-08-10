// Logging. Plain text, no request correlation.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export const logger = {
  info(message: string, fields: object = {}): void {
    console.log(`INFO  ${message} ${JSON.stringify(fields)}`);
  },
  warn(message: string, fields: object = {}): void {
    console.warn(`WARN  ${message} ${JSON.stringify(fields)}`);
  },
  error(message: string, fields: object = {}): void {
    console.error(`ERROR ${message} ${JSON.stringify(fields)}`);
  },
};
