jest.mock('../../../scripts/utils/load-env', () => ({
  loadEnv: jest.fn(),
}));

const { createPreviewIntakePayload, isTruthy } = require('../../../scripts/frontend/serve-landing');

describe('serve-landing', () => {
  test('recognizes truthy skip-build flags', () => {
    expect(isTruthy('1')).toBe(true);
    expect(isTruthy('true')).toBe(true);
    expect(isTruthy('yes')).toBe(true);
    expect(isTruthy('on')).toBe(true);
    expect(isTruthy('0')).toBe(false);
    expect(isTruthy('')).toBe(false);
  });

  test('creates tenant signup preview intake responses for local Browser QA', () => {
    const payload = createPreviewIntakePayload('/__tenant-signup', {
      email: 'ops@example.com',
      organization_name: 'MasarX Tenant Co',
    });

    expect(payload).toMatchObject({
      ok: true,
      status: 'pending',
      email: 'ops@example.com',
      organization_name: 'MasarX Tenant Co',
    });
    expect(payload.request_id).toMatch(/^tsr_local_\d+$/);
    expect(payload.received_at).toEqual(expect.any(String));
  });

  test('keeps contact and driver preview responses domain-specific', () => {
    expect(createPreviewIntakePayload('/__landing-contact', {
      email: 'lead@example.com',
      company: 'Lead Co',
    })).toMatchObject({
      ok: true,
      status: 'received',
      email: 'lead@example.com',
      company: 'Lead Co',
    });

    expect(createPreviewIntakePayload('/__driver-signup', {
      email: 'driver@example.com',
    })).toMatchObject({
      ok: true,
      status: 'submitted',
      email: 'driver@example.com',
    });
  });
});
