#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const DEFAULT_RELATIVE_PATH = path.join('config', 'ci', 'ui-flake-quarantine.json');

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      valid: false,
      errors: [`entries[${index}] must be an object.`],
      entry: null,
    };
  }
  const specPattern = normalizeString(entry.spec_pattern);
  const owner = normalizeString(entry.owner);
  const reason = normalizeString(entry.reason);
  const burnDownBy = normalizeString(entry.burn_down_by);
  const stageScope = Array.isArray(entry.stage_scope)
    ? entry.stage_scope.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  const packs = Array.isArray(entry.packs)
    ? entry.packs.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  const errors = [];
  if (!specPattern) errors.push(`entries[${index}].spec_pattern is required.`);
  if (!owner) errors.push(`entries[${index}].owner is required.`);
  if (!reason) errors.push(`entries[${index}].reason is required.`);
  if (!burnDownBy) errors.push(`entries[${index}].burn_down_by is required.`);

  return {
    valid: errors.length === 0,
    errors,
    entry: {
      spec_pattern: specPattern,
      owner,
      reason,
      burn_down_by: burnDownBy,
      stage_scope: stageScope,
      packs,
    },
  };
}

function loadUiFlakeQuarantine(repoRoot = process.cwd(), relativePath = DEFAULT_RELATIVE_PATH) {
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      path: absolutePath,
      version: '',
      entries: [],
      valid: false,
      errors: [`Missing UI flake quarantine manifest: ${relativePath}`],
    };
  }

  let rawPayload = null;
  try {
    rawPayload = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    return {
      path: absolutePath,
      version: '',
      entries: [],
      valid: false,
      errors: [`Invalid JSON in ${relativePath}: ${error.message}`],
    };
  }

  const version = normalizeString(rawPayload?.version);
  const entries = [];
  const errors = [];
  const sourceEntries = Array.isArray(rawPayload?.entries) ? rawPayload.entries : [];
  for (const [index, item] of sourceEntries.entries()) {
    const normalized = normalizeEntry(item, index);
    if (normalized.entry) entries.push(normalized.entry);
    errors.push(...normalized.errors);
  }
  if (!version) {
    errors.push(`Missing "version" in ${relativePath}.`);
  }

  return {
    path: absolutePath,
    version,
    entries,
    valid: errors.length === 0,
    errors,
  };
}

if (require.main === module) {
  const report = loadUiFlakeQuarantine();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.valid ? 0 : 1);
}

module.exports = {
  DEFAULT_RELATIVE_PATH,
  loadUiFlakeQuarantine,
  normalizeEntry,
};
