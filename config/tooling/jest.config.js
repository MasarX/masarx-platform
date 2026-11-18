const path = require('path');
const { WORKTREE_JEST_ROOTS, WORKTREE_TEMP_IGNORE_PATTERNS, JEST_CACHE_DIRECTORY } = require('./jest.shared');

module.exports = {
  rootDir: path.join(__dirname, '..', '..'),
  ...(JEST_CACHE_DIRECTORY ? { cacheDirectory: JEST_CACHE_DIRECTORY } : {}),
  roots: WORKTREE_JEST_ROOTS,
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.js'],
  testPathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  modulePathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  watchPathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  verbose: true,
  testTimeout: 90000, // allow external API calls
  setupFilesAfterEnv: ['<rootDir>/config/tooling/jest.bootstrap.js'],
  reporters: ['default', '<rootDir>/config/tooling/jest.qa.reporter.js'],
  collectCoverageFrom: [
    'scripts/**/*.js',
    'tests/fixtures/**/*.js',
    '!**/node_modules/**'
  ]
};
