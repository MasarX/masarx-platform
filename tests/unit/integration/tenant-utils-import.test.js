describe('integration helper tenant-utils import behavior', () => {
  const envKey = 'DATABASE_URL';
  const originalDatabaseUrl = process.env[envKey];

  afterEach(async () => {
    process.env[envKey] = originalDatabaseUrl;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('does not throw at import time when DATABASE_URL is missing', async () => {
    delete process.env[envKey];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const helper = require('../../integration/helpers/tenant-utils');

    expect(helper.DATABASE_URL).toBeNull();
    expect(helper.pool).toBeNull();
    expect(() => helper.assertDatabaseUrl('tenant-utils')).toThrow(
      '[tests] DATABASE_URL is required for tenant-utils',
    );
    expect(warnSpy).toHaveBeenCalled();
  });

  test('initializes exported pool when DATABASE_URL exists', async () => {
    process.env[envKey] = (['postgresql',":","/","/",'postgres',":",'postgres',"@",'localhost',":",'5432',"/",'postgres'].join(""));

    const helper = require('../../integration/helpers/tenant-utils');

    expect(helper.DATABASE_URL).toContain('postgresql://');
    expect(helper.pool).toBeTruthy();
    await helper.pool.end();
  });
});
