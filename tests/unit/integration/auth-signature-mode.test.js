const {
  formatAuthSignatureContext,
  isAuthSignatureModeError,
  logAuthSignatureModeSkip,
} = require('../../integration/helpers/auth-signature-mode');

describe('auth-signature-mode helper', () => {
  test('auth mismatch fails closed without exposing sensitive response context', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const sensitive = 'DO_NOT_EMIT_SECRET';
    try {
      const payload = { message: 'Invalid Compact JWS', context: { body: sensitive } };
      expect(isAuthSignatureModeError(payload)).toBe(true);
      let failure;
      try { logAuthSignatureModeSkip('owned-proof', payload); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: '[owned-proof] prerequisite_blocked: auth_signature_mismatch',
        code: 'INTEGRATION_PREREQUISITE_BLOCKED',
        prerequisite: 'auth_signature_mismatch',
      });
      expect(String(failure.stack) + JSON.stringify(failure)).not.toContain(sensitive);
      expect(failure).not.toHaveProperty('cause');
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  test('detects auth signature mode in plain text', () => {
    expect(isAuthSignatureModeError('Invalid Compact JWS')).toBe(true);
    expect(isAuthSignatureModeError('signature verification failed')).toBe(true);
  });

  test('detects auth signature mode in nested error payloads', () => {
    const payload = {
      message: 'Edge Function returned a non-2xx status code',
      context: {
        status: 403,
        body: { error: 'Unauthorized', message: 'Invalid Compact JWS' },
      },
    };
    expect(isAuthSignatureModeError(payload)).toBe(true);
    expect(formatAuthSignatureContext(payload)).toContain('Invalid Compact JWS');
  });

  test('does not match unrelated failures', () => {
    expect(isAuthSignatureModeError('duplicate key value violates unique constraint')).toBe(false);
    expect(
      isAuthSignatureModeError({
        message: 'Edge Function returned a non-2xx status code',
        context: { status: 500, body: { error: 'internal server error' } },
      }),
    ).toBe(false);
  });
});
