#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadEnv } = require('../utils/load-env');

const VALID_ENVIRONMENTS = ['dev', 'stg', 'prod'];
const VALID_VERIFICATION_PROFILES = ['full', 'prod-safe'];

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    envs: [],
    all: false,
    apply: false,
    allowProd: false,
    backupOnly: false,
    skipReset: false,
    skipProvision: false,
    skipVerification: false,
    verificationProfile: '',
    date: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;

    if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--all') out.all = true;
    else if (token === '--apply') out.apply = true;
    else if (token === '--allow-prod') out.allowProd = true;
    else if (token === '--backup-only') out.backupOnly = true;
    else if (token === '--skip-reset') out.skipReset = true;
    else if (token === '--skip-provision') out.skipProvision = true;
    else if (token === '--skip-verification') out.skipVerification = true;
    else if (token === '--verification-profile') out.verificationProfile = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--verification-profile=')) {
      out.verificationProfile = token.split('=').slice(1).join('=').trim();
    }
    else if (token === '--env') out.envs.push(String(argv[i + 1] || '').trim()), i += 1;
    else if (token.startsWith('--env=')) out.envs.push(token.split('=').slice(1).join('=').trim());
    else if (token === '--date') out.date = String(argv[i + 1] || '').trim(), i += 1;
    else if (token.startsWith('--date=')) out.date = token.split('=').slice(1).join('=').trim();
  }

  return out;
}

function resolveExecutionDate(dateValue, now = new Date()) {
  const raw = String(dateValue || '').trim();
  if (!raw) return now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`Invalid --date value: ${raw}. Expected YYYY-MM-DD.`);
  }
  return raw;
}

function resolveTargetEnvironments(args = {}) {
  const requested = args.all ? [...VALID_ENVIRONMENTS] : (args.envs || []);
  const unique = Array.from(new Set(requested.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)));

  if (!unique.length) {
    throw new Error('No environments selected. Use --all or one or more --env <dev|stg|prod>.');
  }

  for (const envName of unique) {
    if (!VALID_ENVIRONMENTS.includes(envName)) {
      throw new Error(`Unsupported environment "${envName}". Allowed: ${VALID_ENVIRONMENTS.join(', ')}.`);
    }
  }

  if (unique.includes('prod') && !args.allowProd) {
    throw new Error('Production rollout requires --allow-prod.');
  }

  return unique;
}

function npmCmdForPlatform(platform = process.platform) {
  return platform.startsWith('win') ? 'npm.cmd' : 'npm';
}

function resolveVerificationProfile(options = {}) {
  const envName = String(options.envName || '').trim().toLowerCase();
  const requested = String(options.requestedProfile || '').trim().toLowerCase();
  const profile = requested || (envName === 'prod' ? 'prod-safe' : 'full');

  if (!VALID_VERIFICATION_PROFILES.includes(profile)) {
    throw new Error(
      `Unsupported verification profile "${profile}". Allowed: ${VALID_VERIFICATION_PROFILES.join(', ')}.`,
    );
  }

  if (envName === 'prod' && profile !== 'prod-safe') {
    throw new Error('Production rollout requires --verification-profile=prod-safe.');
  }

  return profile;
}

function assertProdFixtureMutationGuard(options = {}) {
  const envName = String(options.envName || '').trim().toLowerCase();
  if (envName !== 'prod') return;

  const env = options.env || process.env;
  const allowProdFixtureBootstrap = String(env.TEST_FIXTURE_BOOTSTRAP_ALLOW_PRODUCTION || '').trim();
  if (allowProdFixtureBootstrap) {
    throw new Error(
      'Refusing prod rollout: TEST_FIXTURE_BOOTSTRAP_ALLOW_PRODUCTION must be unset for production verification.',
    );
  }

  const integrationSkipFixtureBootstrap = String(env.INTEGRATION_SKIP_FIXTURE_BOOTSTRAP || '').trim();
  if (integrationSkipFixtureBootstrap === '0') {
    throw new Error(
      'Refusing prod rollout: INTEGRATION_SKIP_FIXTURE_BOOTSTRAP=0 enables fixture bootstrap against prod.',
    );
  }

  const pgtapSkipFixtureBootstrap = String(env.PGTAP_SKIP_FIXTURE_BOOTSTRAP || '').trim();
  if (pgtapSkipFixtureBootstrap === '0') {
    throw new Error(
      'Refusing prod rollout: PGTAP_SKIP_FIXTURE_BOOTSTRAP=0 enables fixture bootstrap against prod.',
    );
  }
}

function buildEnvironmentCommands(options = {}) {
  const envName = String(options.envName || '').trim().toLowerCase();
  const date = String(options.date || '').trim();
  if (!VALID_ENVIRONMENTS.includes(envName)) {
    throw new Error(`Invalid envName: ${envName}`);
  }
  if (!date) {
    throw new Error('buildEnvironmentCommands requires a non-empty date.');
  }

  const verificationProfile = resolveVerificationProfile({
    envName,
    requestedProfile: options.verificationProfile,
  });
  assertProdFixtureMutationGuard({
    envName,
    env: options.env || process.env,
  });

  const evidenceDir = path.join('docs', 'ops', 'evidence', date, 'prega-reset', envName);
  const steps = [];
  const npmCmd = npmCmdForPlatform(options.platform);
  const pgtapFilesPerSession = String(
    options.pgtapFilesPerSession || process.env.PGTAP_FILES_PER_SESSION || '25',
  ).trim();

  steps.push({
    label: 'backup:schema',
    cmd: process.execPath,
    args: [
      path.join('scripts', 'ops', 'prega-db-dump.js'),
      '--schema',
      '--file',
      path.join(evidenceDir, 'schema.sql'),
    ],
  });
  steps.push({
    label: 'backup:data',
    cmd: process.execPath,
    args: [
      path.join('scripts', 'ops', 'prega-db-dump.js'),
      '--data',
      '--file',
      path.join(evidenceDir, 'data.dump'),
    ],
  });

  if (!options.backupOnly) {
    if (!options.skipReset) {
      const resetStep = {
        label: 'reset',
        cmd: process.execPath,
        args: [
          path.join('scripts', 'ops', 'supabase-cli.js'),
          'reset',
          '--confirm-reset',
          `--confirm-env=${envName}`,
        ],
      };
      if (envName === 'prod') {
        resetStep.env = { SUPABASE_CLI_ALLOW_PRODUCTION_RESET: '1' };
      }
      steps.push(resetStep);
    }

    steps.push({
      label: 'db:push',
      cmd: process.execPath,
      args: [path.join('scripts', 'ops', 'supabase-cli.js'), 'push'],
    });

    if (!options.skipProvision) {
      steps.push({
        label: 'configure:edge-api-caller',
        cmd: npmCmd,
        args: ['run', 'configure:edge-api-caller'],
      });
      steps.push({
        label: 'ensure:storage-buckets',
        cmd: npmCmd,
        args: ['run', 'ensure:storage-buckets'],
      });
    }

    if (!options.skipVerification) {
      steps.push({
        label: 'lint:db',
        cmd: npmCmd,
        args: ['run', 'lint:db'],
      });

      if (verificationProfile === 'full') {
        const pgtapStep = {
          label: 'test:pgtap',
          cmd: npmCmd,
          args: ['run', 'test:pgtap'],
        };
        const pgtapEnv = {};
        if (pgtapFilesPerSession) {
          pgtapEnv.PGTAP_FILES_PER_SESSION = pgtapFilesPerSession;
        }
        if (Object.keys(pgtapEnv).length) {
          pgtapStep.env = pgtapEnv;
        }
        steps.push(pgtapStep);
        steps.push({
          label: 'test:integration',
          cmd: npmCmd,
          args: ['run', 'test:integration'],
        });
      } else {
        steps.push({
          label: 'db:connect:smoke',
          cmd: process.execPath,
          args: [path.join('scripts', 'ops', 'db-connect-smoke.js')],
        });
        steps.push({
          label: 'workflow-intake-smoke',
          cmd: process.execPath,
          args: [path.join('scripts', 'ops', 'gates', 'workflow-intake-smoke.js')],
        });
        steps.push({
          label: 'prod:data-hygiene:audit',
          cmd: process.execPath,
          args: [
            path.join('scripts', 'ops', 'audit', 'prod-data-hygiene-audit.js'),
            '--profile=pre-live',
            `--environment=${envName}`,
            '--baseline=config/ops/prod-canonical-baseline.json',
          ],
        });
      }
    }
  }

  return { evidenceDir, verificationProfile, steps };
}

function formatCommand(step) {
  return [step.cmd, ...(step.args || [])].join(' ');
}

function runStep(step, env = process.env) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(step.cmd, step.args || [], {
    stdio: 'inherit',
    env: { ...env, ...(step.env || {}) },
  });
  const endedAt = new Date().toISOString();

  if (result.error) {
    throw new Error(`${step.label} failed to start: ${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`${step.label} exited with status ${result.status}`);
  }

  return { startedAt, endedAt, status: 'ok' };
}

function isTruthyFlag(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function ensureApplyAllowed(apply, env = process.env) {
  if (!apply) return;
  if (String(env.CI || '').trim().toLowerCase() === 'true' && !isTruthyFlag(env.SUPABASE_CLI_ALLOW_RESET_IN_CI)) {
    throw new Error('Refusing --apply in CI without SUPABASE_CLI_ALLOW_RESET_IN_CI=1.');
  }
}

function printUsage() {
  console.log('Usage: node scripts/ops/prega-reset-rollout.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --all                          Run ordered rollout for dev, stg, prod');
  console.log('  --env <dev|stg|prod>           Target environment (repeatable)');
  console.log('  --allow-prod                   Required when prod is selected');
  console.log('  --date <YYYY-MM-DD>            Evidence folder date (default: today UTC)');
  console.log('  --backup-only                  Run backup steps only');
  console.log('  --skip-reset                   Skip reset step');
  console.log('  --skip-provision               Skip edge/config provisioning steps');
  console.log('  --skip-verification            Skip lint/test verification steps');
  console.log('  --verification-profile <name>  Verification profile: full|prod-safe');
  console.log('  --apply                        Execute commands (default is dry-run)');
  console.log('  --help, -h                     Show usage');
}

function main() {
  loadEnv();
  const args = parseArgs();
  if (args.help) {
    printUsage();
    return;
  }

  ensureApplyAllowed(args.apply);

  const runDate = resolveExecutionDate(args.date);
  const targetEnvs = resolveTargetEnvironments(args);
  const manifest = {
    generated_at: new Date().toISOString(),
    date: runDate,
    apply: Boolean(args.apply),
    target_envs: targetEnvs,
    options: {
      backup_only: Boolean(args.backupOnly),
      skip_reset: Boolean(args.skipReset),
      skip_provision: Boolean(args.skipProvision),
      skip_verification: Boolean(args.skipVerification),
      verification_profile: String(args.verificationProfile || '').trim() || 'auto',
    },
    runs: [],
  };

  for (const envName of targetEnvs) {
    const envRun = {
      env: envName,
      deploy_env: envName,
      steps: [],
    };
    const executionPlan = buildEnvironmentCommands({
      envName,
      date: runDate,
      backupOnly: args.backupOnly,
      skipReset: args.skipReset,
      skipProvision: args.skipProvision,
      skipVerification: args.skipVerification,
      verificationProfile: args.verificationProfile,
    });
    envRun.evidence_dir = executionPlan.evidenceDir;
    envRun.verification_profile = executionPlan.verificationProfile;
    manifest.runs.push(envRun);

    if (!args.apply) {
      console.log(`[prega-reset-rollout] DRY-RUN ${envName}`);
      console.log(`[prega-reset-rollout] Evidence dir: ${executionPlan.evidenceDir}`);
      console.log(`[prega-reset-rollout] Verification profile: ${executionPlan.verificationProfile}`);
      executionPlan.steps.forEach((step) => {
        console.log(`- ${step.label}: ${formatCommand(step)}`);
      });
      continue;
    }

    fs.mkdirSync(executionPlan.evidenceDir, { recursive: true });
    for (const step of executionPlan.steps) {
      console.log(`[prega-reset-rollout] ${envName} -> ${step.label}`);
      const entry = {
        label: step.label,
        command: formatCommand(step),
      };
      try {
        const outcome = runStep(step, { ...process.env, DEPLOY_ENV: envName });
        entry.status = outcome.status;
        entry.started_at = outcome.startedAt;
        entry.ended_at = outcome.endedAt;
      } catch (error) {
        entry.status = 'failed';
        entry.error = error.message;
        envRun.steps.push(entry);
        manifest.completed = false;
        const manifestPath = path.join('docs', 'ops', 'evidence', runDate, 'prega-reset', 'rollout-manifest.json');
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        throw error;
      }
      envRun.steps.push(entry);
    }
  }

  manifest.completed = true;
  const manifestPath = path.join('docs', 'ops', 'evidence', runDate, 'prega-reset', 'rollout-manifest.json');
  if (args.apply) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`[prega-reset-rollout] Wrote manifest: ${manifestPath}`);
  } else {
    console.log('[prega-reset-rollout] Dry-run complete. Use --apply during approved maintenance window.');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[prega-reset-rollout] ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  assertProdFixtureMutationGuard,
  buildEnvironmentCommands,
  ensureApplyAllowed,
  isTruthyFlag,
  parseArgs,
  resolveExecutionDate,
  resolveVerificationProfile,
  resolveTargetEnvironments,
};
