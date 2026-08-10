// Outbound SMS. One attempt, no retry.
// Part of the CORTEX benchmark fixture corpus. Not production code.

export async function sendSms(to: string, text: string): Promise<void> {
  await fetch('https://sms.example.com/send', {
    method: 'POST',
    body: JSON.stringify({ to, text }),
  });
}
