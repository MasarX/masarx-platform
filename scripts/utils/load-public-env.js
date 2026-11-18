const fs = require('fs');
const path = require('path');
const { readEnvFile } = require('./env-file');

const PUBLIC_PREFIX = 'NEXT_PUBLIC_';
const APP_NAME_KEYS = {
  console: 'NEXT_PUBLIC_APP_NAME_CONSOLE',
  portal: 'NEXT_PUBLIC_APP_NAME_PORTAL',
  fieldops: 'NEXT_PUBLIC_APP_NAME_FIELDOPS',
};
const FALLBACK_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];

function normalizeEnvFilePath(envFile, repoRoot) {
  if (!envFile) return null;
  const trimmed = String(envFile).trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(repoRoot, normalized);
}

function resolveRepoRoot(startDir) {
  if (!startDir) return process.cwd();
  let current = path.resolve(startDir);
  while (true) {
    const marker = path.join(current, 'config', 'env');
    if (fs.existsSync(marker)) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) return startDir;
    current = parent;
  }
}

function parseEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return readEnvFile(filePath);
  } catch {
    return null;
  }
}

function mergeEnvEntries(candidates) {
  const merged = {};
  for (const candidate of candidates) {
    const parsed = parseEnvFile(candidate);
    if (!parsed) continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (merged[key]) continue;
      merged[key] = value;
    }
  }
  return merged;
}

function applyPublicEnv(entries, options = {}) {
  if (!entries) return;
  const secondaryEntries = options.secondaryEntries || {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(PUBLIC_PREFIX)) continue;
    const existing = process.env[key];
    if (
      existing &&
      (options.initialEnv === undefined || Object.prototype.hasOwnProperty.call(options.initialEnv, key) || existing !== secondaryEntries[key])
    ) {
      continue;
    }
    process.env[key] = value;
  }
}

function applyFallbackEnv(entries, options = {}) {
  if (!entries) return;
  const secondaryEntries = options.secondaryEntries || {};
  for (const key of FALLBACK_ENV_KEYS) {
    if (!entries[key]) continue;
    const existing = process.env[key];
    if (
      existing &&
      (options.initialEnv === undefined || Object.prototype.hasOwnProperty.call(options.initialEnv, key) || existing !== secondaryEntries[key])
    ) {
      continue;
    }
    process.env[key] = entries[key];
  }
}

function resolveAppSegment(appDir) {
  if (!appDir) return null;
  const parts = path.resolve(appDir).split(path.sep).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (APP_NAME_KEYS[parts[i]]) return parts[i];
  }
  return null;
}

function resolveAppNameKey(appDir) {
  const appName = resolveAppSegment(appDir);
  return appName ? APP_NAME_KEYS[appName] : null;
}

function formatFallbackAppName(appDir) {
  if (!appDir) return null;
  const appSegment = resolveAppSegment(appDir);
  const base = (appSegment || path.basename(appDir)).replace(/[-_]/g, ' ').trim();
  if (!base) return null;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function applySupabaseFallbacks() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_ANON_KEY) {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  }
}

function applyAppNameFallback(appDir) {
  if (!process.env.NEXT_PUBLIC_APP_NAME) {
    const appKey = resolveAppNameKey(appDir);
    if (appKey && process.env[appKey]) {
      process.env.NEXT_PUBLIC_APP_NAME = process.env[appKey];
    } else {
      const fallbackName = formatFallbackAppName(appDir);
      if (fallbackName) {
        process.env.NEXT_PUBLIC_APP_NAME = fallbackName;
      }
    }
  }
}

function loadPublicEnv({ appDir, initialEnv } = {}) {
  const resolvedAppDir = path.resolve(appDir || process.cwd());
  const repoRoot = resolveRepoRoot(resolvedAppDir);
  const envRoot = path.join(repoRoot, 'config', 'env');
  const explicitEnvFile = normalizeEnvFilePath(process.env.ENV_FILE, repoRoot);
  const primaryCandidates = [
    explicitEnvFile,
    path.join(envRoot, '.env.cloud'),
    path.join(envRoot, '.env.local'),
    path.join(envRoot, '.env'),
    path.join(repoRoot, '.env'),
  ].filter(Boolean);
  const secondaryCandidates = [
    path.join(resolvedAppDir, '.env.local'),
    path.join(resolvedAppDir, '.env'),
  ];

  const primaryEntries = mergeEnvEntries(primaryCandidates);
  const secondaryEntries = mergeEnvEntries(secondaryCandidates);
  applyFallbackEnv(primaryEntries, { secondaryEntries, initialEnv });
  if (!primaryEntries.NEXT_PUBLIC_SUPABASE_URL && primaryEntries.SUPABASE_URL) {
    primaryEntries.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
  if (!primaryEntries.NEXT_PUBLIC_SUPABASE_ANON_KEY && primaryEntries.SUPABASE_ANON_KEY) {
    primaryEntries.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  }
  applyPublicEnv(primaryEntries, { secondaryEntries, initialEnv });
  applySupabaseFallbacks();
  applyPublicEnv(secondaryEntries);
  applyFallbackEnv(secondaryEntries);
  applySupabaseFallbacks();
  applyAppNameFallback(resolvedAppDir);
}

module.exports = {
  loadPublicEnv,
};
