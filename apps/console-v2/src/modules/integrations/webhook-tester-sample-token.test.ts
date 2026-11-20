import { expect, it, vi } from 'vitest';
import { buildWebhookSampleTemplateContext } from './webhook-tester';

const now = new Date('2024-01-01T00:00:00Z');

it.each([
  ['-._\u00e9--Ab_2--- \n', '_---Ab_2'],
  ['-\u{1f642}---', 'console-v2-sample'],
  [`--${'A'.repeat(71)}-Z---`, `${'A'.repeat(71)}-`],
])('preserves sample token normalization for %j', (input, expected) => {
  expect(buildWebhookSampleTemplateContext(input, now).idempotency_key).toBe(expected);
});

it('keeps the clock fallback for whitespace and trims the email token after truncation', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now.valueOf());
  try {
    expect(buildWebhookSampleTemplateContext('\u00a0\t\n', now).idempotency_key)
      .toBe(`console-v2-${now.valueOf()}`);
  } finally {
    clock.mockRestore();
  }
  const { recipient_email } = buildWebhookSampleTemplateContext(`${'A'.repeat(71)}-Z`, now);
  expect(recipient_email).toBe(`recipient+${'a'.repeat(71)}@example.com`);
});

it('normalizes a large sample key within the CPU budget', () => {
  const input = `a${'-'.repeat(40_000)}b`;
  const start = process.cpuUsage();
  const result = buildWebhookSampleTemplateContext(input, now).idempotency_key;
  const { user, system } = process.cpuUsage(start);

  expect(result).toBe(`a${'-'.repeat(71)}`);
  expect(user + system).toBeLessThan(400_000);
});
