// Money. Amounts are floats, which has caused rounding complaints.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export function format(amount: number, currency = 'PLN'): string {
  return `${amount.toFixed(2)} ${currency}`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function percentage(amount: number, percent: number): number {
  return amount * (percent / 100);
}
