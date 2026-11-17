const { checkEnv, parseArgs } = require('../../../scripts/ops/ci/require-env');

describe('require-env', () => {
  test('parseArgs supports --keys csv and --equals', () => {
    expect(parseArgs(['--keys', 'A,B', '--equals', 'FLAG=enabled'])).toEqual({
      keys: ['A', 'B'],
      equals: ['FLAG=enabled'],
    });
  });

  test('checkEnv reports missing keys', () => {
    expect(checkEnv({ env: { A: '1' }, keys: ['A', 'B'], equals: [] })).toEqual({
      ok: false,
      missing: ['B'],
      mismatched: [],
    });
  });

  test('checkEnv reports equals mismatch', () => {
    expect(checkEnv({ env: { FLAG: 'nope' }, keys: [], equals: ['FLAG=enabled'] })).toEqual({
      ok: false,
      missing: [],
      mismatched: ['FLAG=nope (expected enabled)'],
    });
  });

  test('checkEnv is ok when requirements satisfied', () => {
    expect(checkEnv({ env: { A: 'x', FLAG: 'enabled' }, keys: ['A'], equals: ['FLAG=enabled'] })).toEqual({
      ok: true,
      missing: [],
      mismatched: [],
    });
  });
});

