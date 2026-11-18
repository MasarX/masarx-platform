#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const require = createRequire(import.meta.url);
const envLocalPath = path.join(appRoot, '.env.local');
const defaultManifestPath = path.resolve(appRoot, '../../tmp/live-console-e2e-manifest.json');

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return null;
  const separator = trimmed.indexOf('=');
  const name = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return name ? [name, value] : null;
}

function loadLocalEnv() {
  if (!fs.existsSync(envLocalPath)) return false;
  const lines = fs.readFileSync(envLocalPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [name, value] = parsed;
    if (process.env[name] == null) {
      process.env[name] = value;
    }
  }
  return true;
}

function resolveAuthManifest() {
  const explicitManifest = String(process.env.E2E_CONSOLE_AUTH_MANIFEST ?? '').trim();
  if (explicitManifest) return explicitManifest;
  if (!fs.existsSync(defaultManifestPath)) return '';
  process.env.E2E_CONSOLE_AUTH_MANIFEST = defaultManifestPath;
  return defaultManifestPath;
}

function hasDirectCredentials() {
  return Boolean(
    String(process.env.E2E_CONSOLE_AUTH_EMAIL ?? '').trim() &&
      String(process.env.E2E_CONSOLE_AUTH_PASSWORD ?? ''),
  );
}

function validateManifest(manifestPath) {
  if (!manifestPath) return false;
  const absolutePath = path.resolve(appRoot, manifestPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`E2E_CONSOLE_AUTH_MANIFEST does not exist: ${absolutePath}`);
  }
  const payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  const password = typeof payload.password === 'string' ? payload.password : '';
  const users = Array.isArray(payload.users) ? payload.users : [];
  const hasEmail = users.some((entry) => typeof entry?.email === 'string' && entry.email.trim());
  if (!password || !hasEmail) {
    throw new Error(
      'E2E_CONSOLE_AUTH_MANIFEST must contain a password and at least one user email.',
    );
  }
  return true;
}

function requireLiveEnv() {
  const failures = [];
  if (String(process.env.VITE_USE_SEED ?? '').trim().toLowerCase() !== 'false') {
    failures.push('VITE_USE_SEED=false');
  }
  if (!String(process.env.VITE_SUPABASE_URL ?? '').trim()) {
    failures.push('VITE_SUPABASE_URL');
  }
  if (!String(process.env.VITE_SUPABASE_ANON_KEY ?? '').trim()) {
    failures.push('VITE_SUPABASE_ANON_KEY');
  }

  const manifestPath = resolveAuthManifest();
  if (!hasDirectCredentials()) {
    validateManifest(manifestPath);
  }

  if (failures.length > 0) {
    throw new Error(
      `Console V2 live E2E requires ${failures.join(
        ', ',
      )}. Seed/mock mode cannot be counted as first-tenant readiness proof.`,
    );
  }
}

function normalizeArgs(rawArgs) {
  const args = ['test', '--config=playwright.e2e.config.ts'];
  const hasGrep = rawArgs.some((arg) => arg === '--grep' || arg === '-g' || arg.startsWith('--grep='));
  if (!hasGrep) {
    args.push('--grep', '@live-readiness');
  }
  args.push(...rawArgs);
  return args;
}

loadLocalEnv();
process.env.E2E_CONSOLE_LIVE = '1';
process.env.VERIFY_BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:5175';
requireLiveEnv();

const playwrightPackage = require.resolve('playwright/package.json');
const playwrightCli = path.join(path.dirname(playwrightPackage), 'cli.js');
const child = spawn(process.execPath, [playwrightCli, ...normalizeArgs(process.argv.slice(2))], {
  cwd: appRoot,
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
