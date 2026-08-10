// Payment provider client, pinned to their v2 API.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { loadConfig } from '../config.js';

export async function providerRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const config = loadConfig();

  return fetch(`${config.paymentProviderUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
