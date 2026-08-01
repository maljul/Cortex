// Loads .env into process.env for every test run. Secrets stay in .env only;
// nothing here reads or echoes a value.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
