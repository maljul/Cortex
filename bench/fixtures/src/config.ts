// Configuration, read once at boot.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export interface Config {
  port: number;
  databaseUrl: string;
  sessionTtlMinutes: number;
  paymentProviderUrl: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/orders',
    sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES ?? 60),
    paymentProviderUrl: process.env.PAYMENT_PROVIDER_URL ?? 'https://payments.example.com/v2',
  };
}
