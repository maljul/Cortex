// Opaque bearer tokens, stored server side.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { newId } from '../lib/ids.js';

export function mintToken(): string {
  return `tok_${newId()}`;
}

export function isWellFormed(token: string): boolean {
  return token.startsWith('tok_') && token.length > 8;
}
