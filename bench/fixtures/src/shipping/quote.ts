// Shipping quotes. Prices are floats.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export interface Quote {
  carrier: string;
  price: number;
  estimatedDays: number;
}

export function quoteFor(weightKg: number, country: string): Quote {
  const base = country === 'PL' ? 3.5 : 9.9;
  return {
    carrier: country === 'PL' ? 'inpost' : 'dhl',
    price: base + weightKg * 0.75,
    estimatedDays: country === 'PL' ? 1 : 4,
  };
}
