const fs = require('fs');
const path = require('path');

const JEST_CACHE_DIRECTORY = process.env.RUNNER_TEMP
  ? fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'masarx-jest-'))
  : undefined;

const WORKTREE_JEST_ROOTS = [
  '<rootDir>/tests',
  '<rootDir>/scripts',
  '<rootDir>/config',
  '<rootDir>/apps',
  '<rootDir>/packages',
  '<rootDir>/supabase',
];

const WORKTREE_UNIT_JEST_ROOTS = [
  '<rootDir>/tests',
];

const WORKTREE_TEMP_IGNORE_PATTERNS = [
  '<rootDir>/.tmp/',
];

module.exports = {
  JEST_CACHE_DIRECTORY,
  WORKTREE_JEST_ROOTS,
  WORKTREE_UNIT_JEST_ROOTS,
  WORKTREE_TEMP_IGNORE_PATTERNS,
};
