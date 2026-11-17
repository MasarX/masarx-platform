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
  WORKTREE_JEST_ROOTS,
  WORKTREE_UNIT_JEST_ROOTS,
  WORKTREE_TEMP_IGNORE_PATTERNS,
};
