const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { configEnvFile, resolveDotenvModule } = require('./env-file');

const LOAD_ENV_EXPLICIT_LOG_CACHE = Symbol.for('masarx.load-env.explicit-log-cache');
const LOAD_ENV_DOTENV_FALLBACK_LOGGED = Symbol.for('masarx.load-env.dotenv-fallback-logged');

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function shouldLogExplicitEnvFile(resolvedPath) {
  if (isTruthy(process.env.LOAD_ENV_VERBOSE)) return true;
  const cache = globalThis[LOAD_ENV_EXPLICIT_LOG_CACHE];
  if (cache instanceof Set) {
    if (cache.has(resolvedPath)) return false;
    cache.add(resolvedPath);
    return true;
  }
  const next = new Set([resolvedPath]);
  globalThis[LOAD_ENV_EXPLICIT_LOG_CACHE] = next;
  return true;
}

function shouldOverrideExplicitEnvFile() {
  return isTruthy(process.env.ENV_FILE_OVERRIDE);
}

function shouldLogDotenvFallback() {
  if (globalThis[LOAD_ENV_DOTENV_FALLBACK_LOGGED]) return false;
  globalThis[LOAD_ENV_DOTENV_FALLBACK_LOGGED] = true;
  return true;
}

function loadConfiguredEnvFile(filePath, { override = false } = {}) {
  if (!resolveDotenvModule() && shouldLogDotenvFallback()) {
    console.warn('[load-env] dotenv is unavailable; using built-in .env parsing fallback.');
  }
  configEnvFile(filePath, { override });
}

function preferIpv4First() {
  // GitHub-hosted runners sometimes have unreliable IPv6 egress to cloud DB hosts.
  // Prefer IPv4 in CI to reduce transient ENETUNREACH failures (Supabase direct host can resolve to IPv6 first).
  if (!isTruthy(process.env.CI) && !isTruthy(process.env.DNS_IPV4FIRST)) return;
  if (typeof dns.setDefaultResultOrder !== 'function') return;
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // best-effort; keep env loading resilient
  }
}

/**
 * Load environment variables for tests and QA scripts.
 * Order of precedence:
 *   1. Value already in process.env (unless ENV_FILE_OVERRIDE is enabled)
 *   2. Explicit ENV_FILE path via process.env.ENV_FILE
 *   3. config/env/.env.cloud
 *   4. config/env/.env.local
 *   5. config/env/.env
 *   6. .env in repo root
 *   7. A cloud example file as a test-only fallback
 */
function loadEnv() {
  preferIpv4First();
  const repoRoot = process.cwd();
  const envDir = path.join(repoRoot, 'config', 'env');
  const cloudFile = path.join(envDir, '.env.cloud');
  let exampleFile = `${cloudFile}.example`;

  let explicitFile = process.env.ENV_FILE;
  if (explicitFile) {
    try {
      explicitFile = explicitFile.trim();
      explicitFile = explicitFile.replace(/\\/g, '/');
      const resolved = path.isAbsolute(explicitFile)
        ? explicitFile
        : path.join(repoRoot, explicitFile);
      if (fs.existsSync(resolved)) {
        if (shouldLogExplicitEnvFile(resolved)) {
          console.warn(`[load-env] Using explicit ENV_FILE=${resolved}`);
        }
        const shouldOverride = shouldOverrideExplicitEnvFile();
        if (shouldOverride && shouldLogExplicitEnvFile(`${resolved}#override`)) {
          console.warn('[load-env] ENV_FILE override mode enabled (ENV_FILE values overwrite existing process.env keys).');
        }
        loadConfiguredEnvFile(resolved, { override: shouldOverride });
        if (!isTruthy(process.env.ENV_FILE_APPEND)) {
          return;
        }
      } else {
        console.warn(`[load-env] Explicit ENV_FILE not found at ${resolved}, falling back.`);
        if (path.basename(resolved) === '.env.cloud') {
          exampleFile = `${resolved}.example`;
        }
      }
    } catch (error) {
      console.warn(`[load-env] Failed to load explicit ENV_FILE=${explicitFile}: ${error.message}`);
    }
  }

  const candidates = [
    cloudFile,
    path.join(envDir, '.env.local'),
    path.join(envDir, '.env'),
    path.join(repoRoot, '.env'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        loadConfiguredEnvFile(candidate, { override: false });
      }
    } catch (error) {
      console.warn(`[load-env] Failed to process ${candidate}: ${error.message}`);
    }
  }

  if (process.env.NODE_ENV === 'test' && process.env.SUPABASE_URL === undefined
      && !fs.existsSync(cloudFile) && fs.existsSync(exampleFile)) {
    try {
      loadConfiguredEnvFile(exampleFile);
      const url = process.env.SUPABASE_URL;
      if (!url || url.includes('<your-project-ref>')) {
        process.env.SUPABASE_URL = 'https://example.invalid';
      }
    } catch (error) {
      console.warn(`[load-env] Failed to process cloud example: ${error.message}`);
    }
  }
}

module.exports = {
  loadEnv,
};
