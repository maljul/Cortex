// Outbound email.
// Part of the CORTEX benchmark fixture corpus. Not production code.

import { render } from './templates.js';

export async function sendEmail(to: string, template: string, data: object): Promise<void> {
  const body = render(template, data);
  await fetch('https://mail.example.com/send', {
    method: 'POST',
    body: JSON.stringify({ to, body }),
  });
}
