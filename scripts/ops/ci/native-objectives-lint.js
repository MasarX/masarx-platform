#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildRegexPattern,
  isMigrationPath,
  listChangedMigrationChanges,
  resolveBaseRef,
} = require('./changed-migrations-regex');

function changedMigrationSelection() {
  const baseRef = resolveBaseRef({ baseArg: '' });
  if (!baseRef) {
    throw new Error('Unable to resolve the admission base ref.');
  }
  return listChangedMigrationChanges({ baseRef, headRef: 'HEAD' });
}

function validateChangedMigrationFiles(selection, root = process.cwd()) {
  const scanPaths = [];
  for (const change of selection) {
    const scanPath = String(change.scanPath || '').replace(/\\/g, '/');
    if (!scanPath) {
      const oldPath = String(change.oldPath || '').replace(/\\/g, '/');
      if (isMigrationPath(oldPath)) {
        throw new Error(
          `Changed migration deletion or rename-away is not allowed by append-only admission: ${oldPath}`,
        );
      }
      continue;
    }
    if (!isMigrationPath(scanPath) || path.posix.normalize(scanPath) !== scanPath) {
      throw new Error(`Invalid changed migration path: ${scanPath || '<empty>'}`);
    }
    const absolute = path.resolve(root, ...scanPath.split('/'));
    const relative = path.relative(path.resolve(root), absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Changed migration escapes the candidate root: ${scanPath}`);
    }
    let stat;
    try {
      stat = require('fs').lstatSync(absolute);
    } catch {
      throw new Error(`Changed migration is absent from the candidate checkout: ${scanPath}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Changed migration is not a regular file: ${scanPath}`);
    }
    scanPaths.push(scanPath);
  }
  return [...new Set(scanPaths)];
}

function changedMigrations() {
  return changedMigrationSelection()
    .map((change) => change.scanPath)
    .filter(Boolean);
}

function main() {
  const selection = changedMigrationSelection();
  const files = validateChangedMigrationFiles(selection);
  const pattern = buildRegexPattern(files);
  if (!pattern) {
    console.log('[native-objectives-lint] No changed migrations; strict objectives lint skipped.');
    return;
  }
  const script = path.join(__dirname, '..', 'objectives-lint.js');
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OBJECTIVES_LINT_INCLUDE: pattern,
      OBJECTIVES_LINT_EXPECTED_FILES_JSON: JSON.stringify(files),
      OBJECTIVES_ENFORCE_RLS_MISSING: '1',
      // Honor exact reviewed historical entries; every net-new omission still fails.
      OBJECTIVES_ENFORCE_POLICY_MISSING: '0',
      OBJECTIVES_LINT_NET_NEW_MODE: 'error',
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[native-objectives-lint] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  changedMigrationSelection,
  changedMigrations,
  main,
  validateChangedMigrationFiles,
};
