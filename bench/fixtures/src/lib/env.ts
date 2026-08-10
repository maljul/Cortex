// Environment access, so process.env is read in one place.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
