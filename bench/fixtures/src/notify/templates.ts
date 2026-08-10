// Message templates.
// Part of the CORTEX benchmark fixture corpus. Not production code.

const templates: Record<string, string> = {
  'order.placed': 'Your order {{id}} is confirmed.',
  'order.cancelled': 'Your order {{id}} was cancelled.',
  'order.shipped': 'Your order {{id}} is on its way.',
};

export function render(name: string, data: object): string {
  const template = templates[name] ?? '';
  return Object.entries(data).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
    template,
  );
}
