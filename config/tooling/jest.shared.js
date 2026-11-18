const fs = require('fs');
const path = require('path');

const JEST_CACHE_DIRECTORY = process.env.RUNNER_TEMP
  ? fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'masarx-jest-'))
  : undefined;

const JEST_SCRIPT_WORKERS = ['test:unit', 'test:ui'].includes(process.env.npm_lifecycle_event)
  ? { maxWorkers: process.env.JEST_SHARD ? 3 : 1 }
  : {};

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
  JEST_SCRIPT_WORKERS,
  WORKTREE_JEST_ROOTS,
  WORKTREE_UNIT_JEST_ROOTS,
  WORKTREE_TEMP_IGNORE_PATTERNS,
};
