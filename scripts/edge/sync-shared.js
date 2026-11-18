#!/usr/bin/env node

/**
 * Copies supabase/functions/_shared into each edge function directory so that
 * Supabase CLI packaging includes the shared utilities.
 */

const fs = require('fs');
const path = require('path');

const functionsRoot = path.join(__dirname, '..', '..', 'supabase', 'functions');
const sharedSource = path.join(functionsRoot, '_shared');

if (process.argv.includes('--if-present') && !fs.existsSync(functionsRoot)) {
  console.log('[edge:sync-shared] Skipped: supabase/functions is absent from this checkout.');
  process.exit(0);
}

if (!fs.existsSync(sharedSource)) {
  console.error('[edge:sync-shared] Source folder supabase/functions/_shared not found.');
  process.exit(1);
}

const copyRecursive = (source, target) => {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const entries = fs.readdirSync(source, { withFileTypes: true });
  entries.forEach((entry) => {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  });
};

const targets = fs.readdirSync(functionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_shared' && !entry.name.startsWith('.'))
  .map((entry) => path.join(functionsRoot, entry.name, '_shared'));

targets.forEach((target) => {
  fs.rmSync(target, { recursive: true, force: true });
  copyRecursive(sharedSource, target);
  console.log(`[edge:sync-shared] Synced ${path.relative(functionsRoot, target)}`);
});

console.log('[edge:sync-shared] Completed.');
