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
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!targetStat?.isDirectory()) {
    if (targetStat) fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
  }

  const entries = fs.readdirSync(source, { withFileTypes: true });
  const sourceNames = new Set(entries.map((entry) => entry.name));
  for (const name of fs.readdirSync(target)) {
    if (!sourceNames.has(name)) {
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
  }

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(sourcePath, targetPath);
      continue;
    }

    const existing = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    if (existing?.isFile()) {
      if (fs.readFileSync(sourcePath).equals(fs.readFileSync(targetPath))) continue;
    } else if (existing) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
};

const targets = fs.readdirSync(functionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_shared' && !entry.name.startsWith('.'))
  .map((entry) => path.join(functionsRoot, entry.name, '_shared'));

targets.forEach((target) => {
  copyRecursive(sharedSource, target);
  console.log(`[edge:sync-shared] Synced ${path.relative(functionsRoot, target)}`);
});

console.log('[edge:sync-shared] Completed.');
