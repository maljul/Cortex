// Connection pool.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { loadConfig } from '../config.js';

export const pool = {
  async query(text: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    const config = loadConfig();
    void config;
    void text;
    void params;
    return { rows: [] };
  },
};
