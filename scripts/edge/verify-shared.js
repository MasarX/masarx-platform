#!/usr/bin/env node

/**
 * Ensures every edge function bundles the exact _shared payload found in the
 * canonical supabase/functions/_shared directory. Prevents stale or missing
 * helpers from reaching production packages.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const functionsRoot = path.join(__dirname, '..', '..', 'supabase', 'functions');
const sharedSource = path.join(functionsRoot, '_shared');

if (!fs.existsSync(sharedSource)) {
  console.error('[edge:verify-shared] Source folder supabase/functions/_shared not found.');
  process.exit(1);
}

function collectFiles(sourceDir) {
  const files = new Map();

  function walk(currentDir, prefix = '') {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.forEach((entry) => {
      const nextPath = path.join(currentDir, entry.name);
      const nextPrefix = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath, nextPrefix);
      } else {
        const contents = fs.readFileSync(nextPath);
        const hash = crypto.createHash('sha256').update(contents).digest('hex');
        files.set(nextPrefix.replace(/\\/g, '/'), hash);
      }
    });
  }

  walk(sourceDir);
  return files;
}

const sourceFiles = collectFiles(sharedSource);
if (sourceFiles.size === 0) {
  console.error('[edge:verify-shared] No files found in supabase/functions/_shared.');
  process.exit(1);
}

const errors = [];

const targets = fs.readdirSync(functionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_shared' && !entry.name.startsWith('.'));

if (targets.length === 0) {
  console.warn('[edge:verify-shared] No edge function folders detected.');
  process.exit(0);
}

targets.forEach((entry) => {
  const sharedTarget = path.join(functionsRoot, entry.name, '_shared');
  if (!fs.existsSync(sharedTarget)) {
    errors.push(`- Missing _shared for function ${entry.name}`);
    return;
  }

  const targetFiles = collectFiles(sharedTarget);
  if (targetFiles.size !== sourceFiles.size) {
    errors.push(`- File count mismatch for function ${entry.name}`);
    return;
  }

  sourceFiles.forEach((hash, relPath) => {
    if (!targetFiles.has(relPath)) {
      errors.push(`- ${entry.name}: Missing file ${relPath}`);
      return;
    }
    if (targetFiles.get(relPath) !== hash) {
      errors.push(`- ${entry.name}: File contents differ for ${relPath}`);
    }
  });
});

if (errors.length > 0) {
  console.error('[edge:verify-shared] Detected issues:');
  errors.forEach((issue) => console.error(issue));
  console.error('[edge:verify-shared] Run npm run edge:sync-shared before deploying.');
  process.exit(1);
}

console.log('[edge:verify-shared] All edge functions bundle the expected _shared payload.');
