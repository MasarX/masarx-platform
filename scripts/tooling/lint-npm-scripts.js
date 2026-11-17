#!/usr/bin/env node
/*
 * lint-npm-scripts.js
 *
 * Fast sanity-check for package.json scripts:
 * - ensures referenced Node entrypoints/config files exist on disk
 * - catches stale/broken commands early (command integrity)
 *
 * Scope: intentionally conservative to avoid false positives.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const pkgPath = path.join(repoRoot, 'package.json');

function die(msg) {
  console.error(`[lint:npm-scripts] ${msg}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stripQuotes(token) {
  const t = String(token || '').trim();
  return t.replace(/^['"]|['"]$/g, '');
}

function looksLikeEnvInterpolation(token) {
  const t = String(token || '');
  // bash: $FOO / ${FOO}; cmd: %FOO%; powershell: $env:FOO
  return /\$[{(A-Za-z_]/.test(t) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(t) || /\$env:[A-Za-z_]/i.test(t);
}

function looksLikeFlag(token) {
  return String(token || '').trim().startsWith('-');
}

function normalizeRelPath(token) {
  const t = stripQuotes(token);
  if (!t) return '';
  // Don't treat URLs as paths
  if (/^https?:\/\//i.test(t)) return '';
  if (looksLikeEnvInterpolation(t)) return '';
  // If absolute, treat as out of scope for repo lint.
  if (path.isAbsolute(t)) return '';
  return path.normalize(t);
}

function checkExists(scriptName, rawPath, kind) {
  const rel = normalizeRelPath(rawPath);
  if (!rel) return { checked: false };
  if (looksLikeFlag(rel)) return { checked: false };
  const abs = path.join(repoRoot, rel);
  const ok = fs.existsSync(abs);
  return { checked: true, ok, abs, rel, kind, scriptName };
}

function collectNodeEntrypoints(scriptName, scriptBody) {
  const out = [];
  const body = String(scriptBody || '');
  const re = /(^|\s)node(?:\.exe)?\s+([^\s|&;]+)/g;
  let m;
  while ((m = re.exec(body))) {
    const token = m[2];
    out.push(token);
  }
  return out;
}

function collectJestConfigs(scriptName, scriptBody) {
  const body = String(scriptBody || '');
  if (!/\bjest\b/.test(body)) return [];
  const out = [];
  const re = /--config\s+([^\s|&;]+)/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

function main() {
  if (!fs.existsSync(pkgPath)) die(`Missing package.json at ${pkgPath}`);
  const pkg = readJson(pkgPath);
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};

  const missing = [];
  let checkedCount = 0;

  for (const [name, body] of Object.entries(scripts)) {
    for (const entry of collectNodeEntrypoints(name, body)) {
      const res = checkExists(name, entry, 'node');
      if (!res.checked) continue;
      checkedCount += 1;
      if (!res.ok) missing.push(res);
    }
    for (const cfg of collectJestConfigs(name, body)) {
      const res = checkExists(name, cfg, 'jest-config');
      if (!res.checked) continue;
      checkedCount += 1;
      if (!res.ok) missing.push(res);
    }
  }

  if (missing.length) {
    const lines = [
      `Missing referenced files (${missing.length}):`,
      ...missing.map((m) => `- ${m.scriptName}: ${m.kind} -> ${m.rel}`),
    ];
    die(lines.join('\n'));
  }

  console.log(`[lint:npm-scripts] OK (${checkedCount} checks)`);
}

main();

