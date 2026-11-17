#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const defaultPolicyPath = path.join(repoRoot, 'config', 'ci', 'control-plane-protected-paths.json');
const defaultCodeownersPath = path.join(repoRoot, '.github', 'CODEOWNERS');

function die(message) {
  console.error(`[sync-control-plane-codeowners] ${message}`);
  process.exit(1);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    write: false,
    check: true,
    policyPath: defaultPolicyPath,
    codeownersPath: defaultCodeownersPath,
    ownerHandles: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      args.write = true;
      args.check = false;
      continue;
    }
    if (arg === '--check') {
      args.write = false;
      args.check = true;
      continue;
    }
    if (arg === '--policy') {
      args.policyPath = path.resolve(argv[++i] || '');
      continue;
    }
    if (arg === '--codeowners') {
      args.codeownersPath = path.resolve(argv[++i] || '');
      continue;
    }
    if (arg === '--owners') {
      const raw = String(argv[++i] || '').trim();
      args.ownerHandles = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function normalizePathPattern(entry) {
  const cleaned = String(entry || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');
  if (!cleaned) return '';
  return `/${cleaned}`;
}

function uniquePreserveOrder(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeContent(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trimEnd();
}

function loadPolicy(policyPath) {
  const raw = fs.readFileSync(policyPath, 'utf8');
  const policy = JSON.parse(raw);
  const version = Number(policy?.version || 0);
  if (version !== 1) {
    throw new Error(`Unsupported policy version ${version}. Expected version=1.`);
  }

  const protectedEntries = Array.isArray(policy?.owner_review_required_for)
    ? policy.owner_review_required_for
    : [];
  if (protectedEntries.length === 0) {
    throw new Error('owner_review_required_for must be a non-empty array');
  }

  const excludedEntries = Array.isArray(policy?.explicitly_excluded_from_owner_review_scope)
    ? policy.explicitly_excluded_from_owner_review_scope
    : [];

  const ownerHandles = Array.isArray(policy?.owner_handles)
    ? policy.owner_handles.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (ownerHandles.length === 0) {
    throw new Error('owner_handles must be configured in control-plane-protected-paths.json');
  }

  const protectedPatterns = uniquePreserveOrder(
    protectedEntries.map((entry) => normalizePathPattern(entry)).filter(Boolean),
  );
  const excludedPatterns = uniquePreserveOrder(
    excludedEntries.map((entry) => normalizePathPattern(entry)).filter(Boolean),
  );

  const protectedSet = new Set(protectedPatterns);
  const overlap = excludedPatterns.filter((entry) => protectedSet.has(entry));
  if (overlap.length > 0) {
    throw new Error(
      `Policy overlap detected between include/exclude lists: ${overlap.join(', ')}`,
    );
  }

  return {
    protectedPatterns,
    excludedPatterns,
    ownerHandles,
  };
}

function buildCodeownersContent(input) {
  const ownersInline = input.ownerHandles.join(' ');
  const header = [
    '# GENERATED FILE - DO NOT EDIT DIRECTLY.',
    '# Source of truth: config/ci/control-plane-protected-paths.json',
    '# Regenerate: npm run ci:codeowners:sync',
    '',
    '# Path-scoped control-plane ownership:',
    '# - Only deployment/branch-governance paths require explicit owner review.',
    '# - Test-only CI changes intentionally remain outside this owner gate.',
    '',
  ];

  const lines = input.protectedPatterns.map((pattern) => `${pattern} ${ownersInline}`);
  return `${header.join('\n')}${lines.join('\n')}\n`;
}

function assertExcludedPathsNotOwned(input) {
  const existingLines = normalizeContent(input.content)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));

  const ownedPatterns = new Set(
    existingLines
      .map((line) => line.split(/\s+/)[0] || '')
      .map((value) => normalizePathPattern(value))
      .filter(Boolean),
  );

  const violations = input.excludedPatterns.filter((pattern) => ownedPatterns.has(pattern));
  if (violations.length > 0) {
    throw new Error(
      `CODEOWNERS includes excluded non-control-plane paths: ${violations.join(', ')}`,
    );
  }
}

function run(args = parseArgs()) {
  const policy = loadPolicy(args.policyPath);
  const ownerHandles = args.ownerHandles.length > 0 ? args.ownerHandles : policy.ownerHandles;
  const generated = buildCodeownersContent({
    protectedPatterns: policy.protectedPatterns,
    ownerHandles,
  });

  if (args.write) {
    fs.mkdirSync(path.dirname(args.codeownersPath), { recursive: true });
    fs.writeFileSync(args.codeownersPath, generated, 'utf8');
    assertExcludedPathsNotOwned({
      content: generated,
      excludedPatterns: policy.excludedPatterns,
    });
    console.log(
      `[sync-control-plane-codeowners] Wrote ${path.relative(repoRoot, args.codeownersPath)} (${policy.protectedPatterns.length} patterns).`,
    );
    return;
  }

  if (!fs.existsSync(args.codeownersPath)) {
    throw new Error(`Missing CODEOWNERS file: ${args.codeownersPath}`);
  }

  const existing = fs.readFileSync(args.codeownersPath, 'utf8');
  assertExcludedPathsNotOwned({
    content: existing,
    excludedPatterns: policy.excludedPatterns,
  });

  const normalizedExisting = normalizeContent(existing);
  const normalizedGenerated = normalizeContent(generated);
  if (normalizedExisting !== normalizedGenerated) {
    throw new Error(
      'CODEOWNERS drift detected for control-plane owner scope. Run: npm run ci:codeowners:sync',
    );
  }

  console.log('[sync-control-plane-codeowners] OK (CODEOWNERS is in sync with control-plane policy).');
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
}

module.exports = {
  parseArgs,
  normalizePathPattern,
  loadPolicy,
  buildCodeownersContent,
  run,
};
