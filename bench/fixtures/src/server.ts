// HTTP entry point for the orders service.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { createRouter } from './router.js';
import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';

export async function start(): Promise<void> {
  const config = loadConfig();
  const router = createRouter();

  logger.info('starting', { port: config.port });

  const server = Bun.serve({
    port: config.port,
    fetch: (request) => router.handle(request),
  });

  logger.info('listening', { port: server.port });
}
