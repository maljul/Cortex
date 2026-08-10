// Generic retry with fixed backoff.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }

  throw lastError;
}
