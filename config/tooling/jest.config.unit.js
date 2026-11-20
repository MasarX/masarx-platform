const path = require('path');
const { WORKTREE_UNIT_JEST_ROOTS, WORKTREE_TEMP_IGNORE_PATTERNS, JEST_CACHE_DIRECTORY, JEST_SCRIPT_WORKERS } = require('./jest.shared');

module.exports = {
  rootDir: path.join(__dirname, '..', '..'),
  ...(JEST_CACHE_DIRECTORY ? { cacheDirectory: JEST_CACHE_DIRECTORY } : {}),
  ...JEST_SCRIPT_WORKERS,
  roots: WORKTREE_UNIT_JEST_ROOTS,
  testEnvironment: 'node',
  setupFilesAfterEnv: [
    '<rootDir>/config/tooling/jest.runtime-env-isolation.js',
  ],
  testMatch: [
    '**/tests/unit/**/*.test.js',
    '**/tests/unit/**/*.test.ts',
    '**/tests/unit/**/*.test.tsx',
    '**/tests/quality/**/*.test.js',
    '**/tests/quality/**/*.test.ts',
  ],
  testPathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  modulePathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  watchPathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.jest.unit.json' },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  verbose: false,
  testTimeout: 10000,
  reporters: ['default', '<rootDir>/config/tooling/jest.qa.reporter.js'],
  collectCoverageFrom: [
    'scripts/**/*.js',
    'config/**/*.js',
    '!**/node_modules/**'
  ],
  coverageReporters: ['text', 'lcov'],
  coverageThreshold: {
    // Apply threshold conservatively to utils we have tests for; expand as unit tests grow
    global: { lines: 0 },
    './scripts/utils/load-env.js': { lines: 60 },
  }
};
