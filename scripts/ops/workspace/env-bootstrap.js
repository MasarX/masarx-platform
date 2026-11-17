#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sanitizeEnvCloud } = require('./env-sanitize');

const REQUIRED_ENV_FILES = [
  path.join('config', 'env', '.env'),
  path.join('config', 'env', '.env.cloud'),
];

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const opts = {
    strict: String(env.WORKSPACE_ENV_BOOTSTRAP_STRICT || '0') === '1',
    sourceRoot: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    const next = String(argv[i + 1] || '').trim();
    if (!token) continue;
    if (token === '--help' || token === '-h') {
      opts.help = true;
      continue;
    }
    if (token === '--strict') {
      opts.strict = true;
      continue;
    }
    if (token === '--no-strict') {
      opts.strict = false;
      continue;
    }
    if (token === '--source' && next) {
      opts.sourceRoot = path.resolve(next);
      i += 1;
      continue;
    }
    if (token.startsWith('--source=')) {
      opts.sourceRoot = path.resolve(token.split('=').slice(1).join('=').trim());
      continue;
    }
  }

  return opts;
}

function printUsage() {
  console.log('Usage: node scripts/ops/workspace/env-bootstrap.js [--strict] [--source <path>]');
  console.log('');
  console.log('Options:');
  console.log('  --strict          Exit non-zero when required env files cannot be seeded.');
  console.log('  --no-strict       Force advisory mode.');
  console.log('  --source <path>   Override primary workspace root used as copy source.');
}

/**
 * Ensure that this workspace has the baseline env files required for
 * automated local + cloud flows. When running inside a Git worktree, this
 * will copy config/env/.env and .env.cloud from the primary workspace (main)
 * into the current workspace if they are missing.
 *
 * This keeps the canonical env values in a single place while allowing
 * per-workspace automation (e.g., `npm run cloud:provision`, `npm run local:start`)
 * without extra manual steps.
 */
function findPrimaryWorkspaceRoot({ spawnSyncImpl = spawnSync, logger = console } = {}) {
  try {
    const res = spawnSyncImpl('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    if (res.status !== 0) return null;
    const lines = (res.stdout || '').split(/\r?\n/);
    const entries = [];
    let current = null;

    for (const line of lines) {
      if (!line) {
        if (current) {
          entries.push(current);
          current = null;
        }
        continue;
      }
      if (line.startsWith('worktree ')) {
        current = current || {};
        // Keep path exactly as reported (may contain spaces).
        current.worktree = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        current = current || {};
        current.branch = line.slice('branch '.length).trim();
      }
    }
    if (current) entries.push(current);

    const mainEntry = entries.find((e) => e.branch === 'refs/heads/main' && e.worktree);
    const firstEntry = entries.find((e) => e.worktree);
    return (mainEntry && mainEntry.worktree) || (firstEntry && firstEntry.worktree) || null;
  } catch (e) {
    logger.warn('[workspace/env-bootstrap] git worktree list failed:', e.message || e);
    return null;
  }
}

function copyIfMissing({ sourceRoot, targetRoot, relPath, fsImpl = fs, logger = console }) {
  const targetPath = path.join(targetRoot, relPath);
  if (fsImpl.existsSync(targetPath)) {
    return {
      copied: false,
      missingSource: false,
      targetPath,
      sourcePath: path.join(sourceRoot, relPath),
    };
  }

  const sourcePath = path.join(sourceRoot, relPath);
  if (!fsImpl.existsSync(sourcePath)) {
    logger.warn(
      `[workspace/env-bootstrap] Source env file not found at ${sourcePath}; skipping.`
    );
    return {
      copied: false,
      missingSource: true,
      targetPath,
      sourcePath,
    };
  }

  const dir = path.dirname(targetPath);
  if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.copyFileSync(sourcePath, targetPath);
  logger.log(`[workspace/env-bootstrap] Bootstrapped ${relPath} from primary workspace.`);
  return {
    copied: true,
    missingSource: false,
    targetPath,
    sourcePath,
  };
}

function printFallbackGuidance({ cwd, logger = console }) {
  logger.log('[workspace/env-bootstrap] Fallback guidance:');
  logger.log('- Preferred: run `npm run remote:provision` to provision in GitHub Actions runtime (secrets-only).');
  logger.log(`- Local fallback: run \`ENV_FILE=config/env/.env.cloud npm run cloud:provision -- "${path.basename(cwd)}"\``);
}

function findMissingRequiredTargets({ cwd, fsImpl = fs }) {
  const missing = [];
  for (const relPath of REQUIRED_ENV_FILES) {
    const targetPath = path.join(cwd, relPath);
    if (!fsImpl.existsSync(targetPath)) {
      missing.push({ relPath, targetPath });
    }
  }
  return missing;
}

function ensureWorkspaceEnv(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const strict = Boolean(options.strict);
  const sourceRootOverride = options.sourceRoot ? path.resolve(options.sourceRoot) : '';
  const fsImpl = options.fsImpl || fs;
  const sanitizeEnvCloudImpl = options.sanitizeEnvCloudImpl || sanitizeEnvCloud;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const logger = options.logger || console;

  const result = {
    status: 'success',
    copied: [],
    warnings: [],
    missingRequired: [],
    sourceRoot: '',
    strict,
  };

  const localEnvDir = path.join(cwd, 'config', 'env');
  if (!fsImpl.existsSync(localEnvDir)) {
    // Nothing to do if this repo does not follow the standard config layout.
    result.status = 'not_applicable';
    return result;
  }

  const primaryRoot = sourceRootOverride || findPrimaryWorkspaceRoot({ spawnSyncImpl, logger });
  result.sourceRoot = primaryRoot || '';
  if (!primaryRoot) {
    const missing = findMissingRequiredTargets({ cwd, fsImpl });
    if (missing.length) {
      const warning = '[workspace/env-bootstrap] Primary workspace root could not be resolved; env seeding skipped.';
      result.warnings.push(warning);
      result.missingRequired.push(...missing);
      logger.warn(warning);
      printFallbackGuidance({ cwd, logger });
      result.status = strict ? 'failed' : 'advisory_skip';
      logger.log(
        `[workspace/env-bootstrap] status=${result.status} copied=${result.copied.length} missing_required=${result.missingRequired.length}`
      );
      return result;
    }
    result.status = 'success';
    logger.log('[workspace/env-bootstrap] status=success copied=0 missing_required=0');
    return result;
  }

  // Avoid copying from ourselves if we are already the primary workspace.
  const normalizedCwd = path.resolve(cwd);
  const normalizedPrimary = path.resolve(primaryRoot);
  if (normalizedCwd === normalizedPrimary) {
    const missing = findMissingRequiredTargets({ cwd, fsImpl });
    if (missing.length) {
      const warning = '[workspace/env-bootstrap] Running on the primary workspace with missing env artifacts.';
      result.warnings.push(warning);
      result.missingRequired.push(...missing);
      logger.warn(warning);
      printFallbackGuidance({ cwd, logger });
      result.status = strict ? 'failed' : 'advisory_skip';
      logger.log(
        `[workspace/env-bootstrap] status=${result.status} copied=${result.copied.length} missing_required=${result.missingRequired.length}`
      );
      return result;
    }
    logger.log('[workspace/env-bootstrap] status=success copied=0 missing_required=0');
    return result;
  }

  const copyEnv = copyIfMissing({
    sourceRoot: primaryRoot,
    targetRoot: cwd,
    relPath: path.join('config', 'env', '.env'),
    fsImpl,
    logger,
  });
  if (copyEnv.copied) {
    result.copied.push(copyEnv.targetPath);
  } else if (copyEnv.missingSource) {
    result.missingRequired.push({
      relPath: path.join('config', 'env', '.env'),
      targetPath: copyEnv.targetPath,
    });
  }

  const copyCloud = copyIfMissing({
    sourceRoot: primaryRoot,
    targetRoot: cwd,
    relPath: path.join('config', 'env', '.env.cloud'),
    fsImpl,
    logger,
  });
  if (copyCloud.copied) {
    result.copied.push(copyCloud.targetPath);
  } else if (copyCloud.missingSource) {
    result.missingRequired.push({
      relPath: path.join('config', 'env', '.env.cloud'),
      targetPath: copyCloud.targetPath,
    });
  }

  if (copyCloud.copied) {
    const targetCloudPath = path.join(cwd, 'config', 'env', '.env.cloud');
    if (sanitizeEnvCloudImpl(targetCloudPath)) {
      logger.log(
        '[workspace/env-bootstrap] Scrubbed copied config/env/.env.cloud (project-specific fields removed).'
      );
    }
  }

  if (result.missingRequired.length) {
    const warning = '[workspace/env-bootstrap] One or more required env files could not be seeded from the primary workspace.';
    result.warnings.push(warning);
    logger.warn(warning);
    printFallbackGuidance({ cwd, logger });
    result.status = strict ? 'failed' : 'advisory_skip';
  } else {
    result.status = 'success';
  }

  logger.log(
    `[workspace/env-bootstrap] status=${result.status} copied=${result.copied.length} missing_required=${result.missingRequired.length}`
  );
  return result;
}

if (require.main === module) {
  const args = parseArgs();
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  const result = ensureWorkspaceEnv({
    strict: args.strict,
    sourceRoot: args.sourceRoot || '',
  });
  if (result.status === 'failed') {
    process.exit(1);
  }
}

module.exports = {
  REQUIRED_ENV_FILES,
  parseArgs,
  findPrimaryWorkspaceRoot,
  copyIfMissing,
  findMissingRequiredTargets,
  printFallbackGuidance,
  ensureWorkspaceEnv,
};
