const unitConfig = require('../../../config/tooling/jest.config.unit');
const uiConfig = require('../../../config/tooling/jest.config.ui');
const integrationConfig = require('../../../config/tooling/jest.config');

const EXPECTED_PATTERN = '<rootDir>/.tmp/';
const EXPECTED_ROOTS = [
  '<rootDir>/tests',
  '<rootDir>/scripts',
  '<rootDir>/config',
  '<rootDir>/apps',
  '<rootDir>/packages',
  '<rootDir>/supabase',
];
const EXPECTED_UNIT_ROOTS = [
  '<rootDir>/tests',
];

function expectTempIgnore(config, expectedRoots = EXPECTED_ROOTS) {
  expect(config.roots).toEqual(expectedRoots);
  expect(config.testPathIgnorePatterns).toEqual(expect.arrayContaining([EXPECTED_PATTERN]));
  expect(config.modulePathIgnorePatterns).toEqual(expect.arrayContaining([EXPECTED_PATTERN]));
  expect(config.watchPathIgnorePatterns).toEqual(expect.arrayContaining([EXPECTED_PATTERN]));
}

describe('jest temp worktree ignores', () => {
  test('unit config ignores temp clones under .tmp', () => {
    expectTempIgnore(unitConfig, EXPECTED_UNIT_ROOTS);
  });

  test('ui config ignores temp clones under .tmp', () => {
    expectTempIgnore(uiConfig);
  });

  test('integration config ignores temp clones under .tmp', () => {
    expectTempIgnore(integrationConfig);
  });
});
