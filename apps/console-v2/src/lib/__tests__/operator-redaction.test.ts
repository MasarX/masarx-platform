import { describe, expect, it } from 'vitest';

import {
  prettyOperatorJson,
  redactHeader,
  redactJsonForOperator,
  redactSensitiveText,
} from '../operator-redaction';

describe('operator redaction', () => {
  it('preserves non-secret intake proof identifiers while redacting credentials', () => {
    const redacted = redactJsonForOperator({
      idempotency_key: 'idem-proof-001',
      'idempotency-key': 'idem-proof-002',
      correlation_id: 'corr-proof-001',
      request_id: 'req-proof-001',
      mapping_key: 'first-tenant.shipment.create',
      api_key: 'secret-api-key',
      access_key: 'secret-access-key',
      nested: {
        auth_token: 'secret-token',
        shipment: { external_id: 'shipment-ref-001' },
      },
    });

    expect(redacted).toMatchObject({
      idempotency_key: 'idem-proof-001',
      'idempotency-key': 'idem-proof-002',
      correlation_id: 'corr-proof-001',
      request_id: 'req-proof-001',
      mapping_key: 'first-tenant.shipment.create',
      api_key: '[redacted]',
      access_key: '[redacted]',
      nested: {
        auth_token: '[redacted]',
        shipment: { external_id: 'shipment-ref-001' },
      },
    });
  });

  it('keeps idempotency-key text visible while hiding source tokens and API keys', () => {
    const text = redactSensitiveText(
      'idempotency-key: idem-proof-003 x-webhook-token: source-secret api_key=inline-secret Authorization: Bearer bearer-secret',
    );

    expect(text).toContain('idempotency-key: idem-proof-003');
    expect(text).toContain('x-webhook-token: [redacted]');
    expect(text).toContain('api_key=[redacted]');
    expect(text).toContain('Authorization: Bearer [redacted]');
    expect(text).not.toContain('source-secret');
    expect(text).not.toContain('inline-secret');
    expect(text).not.toContain('bearer-secret');
  });

  it('keeps proof identifiers visible in pretty JSON output', () => {
    const output = prettyOperatorJson({
      idempotency_key: 'idem-proof-004',
      authorization: 'Bearer bearer-secret',
    });

    expect(output).toContain('"idempotency_key": "idem-proof-004"');
    expect(output).toContain('"authorization": "[redacted]"');
    expect(output).not.toContain('bearer-secret');
  });

  it('redacts sensitive headers without hiding correlation headers', () => {
    expect(redactHeader('Authorization', 'Bearer bearer-secret')).toContain('redacted');
    expect(redactHeader('X-Correlation-Id', 'corr-proof-001')).toBe('corr-proof-001');
    expect(redactHeader('Idempotency-Key', 'idem-proof-005')).toBe('idem-proof-005');
  });
});
