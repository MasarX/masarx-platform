jest.mock('../../../scripts/utils/load-env', () => ({
  loadEnv: jest.fn(),
}));

const { isTruthy } = require('../../../scripts/frontend/serve-landing');

describe('serve-landing', () => {
  test('recognizes truthy skip-build flags', () => {
    expect(isTruthy('1')).toBe(true);
    expect(isTruthy('true')).toBe(true);
    expect(isTruthy('yes')).toBe(true);
    expect(isTruthy('on')).toBe(true);
    expect(isTruthy('0')).toBe(false);
    expect(isTruthy('')).toBe(false);
  });
});
