// Identifier generation.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function shortId(): string {
  return randomUUID().slice(0, 8);
}
