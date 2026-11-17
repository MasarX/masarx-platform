const {
  parseOriginList,
  resolveAllowedDevOrigins,
} = require('../../../apps/shared/next-dev-origins');

describe('apps/shared/next-dev-origins', () => {
  test('parses comma-separated origins with stable de-duping', () => {
    expect(parseOriginList('127.0.0.1, 127.0.0.1, local.masarx.test')).toEqual([
      '127.0.0.1',
      'local.masarx.test',
    ]);
  });

  test('resolves the non-public env override before the public local template value', () => {
    expect(resolveAllowedDevOrigins({
      NEXT_ALLOWED_DEV_ORIGINS: 'console.local.test',
      NEXT_PUBLIC_ALLOWED_DEV_ORIGINS: '127.0.0.1',
    })).toEqual(['console.local.test']);
  });
});
