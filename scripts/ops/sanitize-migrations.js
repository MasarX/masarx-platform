#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function listChangedMigrationSqlFiles({ root, migDir }) {
  const relMigDir = path.relative(root, migDir).replace(/\\/g, '/');
  const res = spawnSync('git', ['status', '--porcelain', '--', relMigDir], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform.startsWith('win'),
  });
  if (res.status !== 0) {
    return null;
  }

  const files = new Set();
  const lines = String(res.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    // Format: "XY path" or "?? path"
    // Rename format includes "old -> new"; pick the new path.
    const parts = line.trim().split(/\s+/);
    const pathPart = parts.slice(1).join(' ');
    if (!pathPart) continue;

    // Skip deleted files (rename lines still include the new path).
    const status = parts[0] || '';
    if (status.includes('D')) continue;

    const rel = pathPart.includes('->') ? pathPart.split('->').pop().trim() : pathPart.trim();
    const normalized = rel.replace(/\\/g, '/');
    if (!normalized.startsWith(`${relMigDir}/`)) continue;
    if (!normalized.toLowerCase().endsWith('.sql')) continue;
    files.add(path.join(root, normalized));
  }

  return Array.from(files);
}

(function main() {
  const root = process.cwd();
  const migDir = path.join(root, 'supabase', 'migrations');
  if (!fs.existsSync(migDir)) {
    console.error('[sanitize-migrations] Directory not found:', migDir);
    process.exit(1);
  }

  // Best practice: keep migrations append-only. Only normalize SQL files that
  // are already changed in this working tree (new/modified), never historical
  // migrations that are untouched.
  const changedFiles = listChangedMigrationSqlFiles({ root, migDir });
  const files = (changedFiles ?? walk(migDir))
    .filter((f) => f.toLowerCase().endsWith('.sql'));
  let fixed = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let buf = fs.readFileSync(f);
    // Remove UTF-8 BOM (0xEF 0xBB 0xBF) at start if present
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      buf = buf.slice(3);
    }
    // Also strip Unicode BOM U+FEFF if present when decoded
    let txt = buf.toString('utf8');
    if (txt.charCodeAt(0) === 0xFEFF) {
      txt = txt.slice(1);
    }
    // Normalize line endings to \n (optional, safe for psql)
    const normalized = txt.replace(/\r\n/g, '\n');
    if (normalized !== fs.readFileSync(f, 'utf8')) {
      fs.writeFileSync(f, normalized, 'utf8');
      console.log('[sanitize-migrations] Fixed', path.relative(root, f));
      fixed++;
    }
  }
  console.log(`[sanitize-migrations] Completed. Files scanned=${files.length}, fixed=${fixed}`);
})();
