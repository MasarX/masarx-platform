const {
  mergeAllowedDevOrigins,
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

  test('merges selected local Playwright hosts with existing allowed origins', () => {
    expect(mergeAllowedDevOrigins(
      'console.local.test',
      ['http://127.0.0.1:3001', 'http://localhost:3002'],
    )).toEqual(['console.local.test', '127.0.0.1', 'localhost']);
  });

  test('resolves the non-public env override before the public local template value', () => {
    expect(resolveAllowedDevOrigins({
      NEXT_ALLOWED_DEV_ORIGINS: 'console.local.test',
      NEXT_PUBLIC_ALLOWED_DEV_ORIGINS: '127.0.0.1',
    })).toEqual(['console.local.test']);
  });
});
