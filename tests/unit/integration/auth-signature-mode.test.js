const {
  formatAuthSignatureContext,
  isAuthSignatureModeError,
} = require('../../integration/helpers/auth-signature-mode');

describe('auth-signature-mode helper', () => {
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
