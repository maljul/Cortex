// Label creation. The address is not checked.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { quoteFor } from './quote.js';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
  country: string;
}

export async function createLabel(address: Address, weightKg: number): Promise<string> {
  const quote = quoteFor(weightKg, address.country);
  return `label:${quote.carrier}:${address.postcode}`;
}
