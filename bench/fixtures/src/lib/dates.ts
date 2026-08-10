// Date helpers, hand rolled.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export function parseDate(text: string): Date {
  const [day, month, year] = text.split('/').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

export function formatDate(date: Date): string {
  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}
