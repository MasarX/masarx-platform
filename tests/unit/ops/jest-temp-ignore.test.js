const unitConfig = require('../../../config/tooling/jest.config.unit');
const uiConfig = require('../../../config/tooling/jest.config.ui');
const integrationConfig = require('../../../config/tooling/jest.config');

describe('shared DOM renderer module resolution', () => {
  function mappedModule(name) {
    const entry = Object.entries(uiConfig.moduleNameMapper)
      .find(([pattern]) => new RegExp(pattern).test(name));
    return entry ? name.replace(new RegExp(entry[0]), entry[1]) : name;
  }

  test.each([
    ['react', '<rootDir>/node_modules/react'],
    ['react/jsx-runtime', '<rootDir>/node_modules/react/jsx-runtime'],
    ['react/jsx-dev-runtime', '<rootDir>/node_modules/react/jsx-dev-runtime'],
    ['react-dom', '<rootDir>/node_modules/react-dom'],
    ['react-dom/client', '<rootDir>/node_modules/react-dom/client'],
    ['react-dom/test-utils', '<rootDir>/node_modules/react-dom/test-utils'],
  ])('binds %s to the shared DOM renderer dependency tree', (name, expected) => {
    expect(mappedModule(name)).toBe(expected);
  });

  test.each(['react-native', 'react-native-web', 'react-is'])(
    'does not redirect unrelated package %s', (name) => {
      expect(mappedModule(name)).toBe(name);
    }
  );
});

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
