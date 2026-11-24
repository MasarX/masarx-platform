jest.mock('../../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));

const { assertEnv } = require('../../utils/test-env');

afterEach(() => jest.restoreAllMocks());

test('required test settings fail for absent and blank values with the setting names', () => {
  jest.replaceProperty(process, 'env', { SUPABASE_ANON_KEY: ' ' });

  expect(() => assertEnv(['SUPABASE_URL', 'SUPABASE_ANON_KEY'], 'Data API')).toThrow(
    'Missing environment variables for Data API: SUPABASE_URL, SUPABASE_ANON_KEY',
  );
});

test('required test settings accept a configured backend', () => {
  jest.replaceProperty(process, 'env', { DATABASE_URL: 'configured' });

  expect(() => assertEnv(['DATABASE_URL'], 'RLS')).not.toThrow();
});
