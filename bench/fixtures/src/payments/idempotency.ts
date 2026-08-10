// Idempotency key helpers. Currently unused by charge.ts.
// Part of the CORTEX benchmark fixture corpus. Not production code.

const seen = new Map<string, string>();

export function remember(key: string, result: string): void {
  seen.set(key, result);
}

export function recall(key: string): string | undefined {
  return seen.get(key);
}
