#!/usr/bin/env node
/**
 * env-isolation-lint.js
 *
 * Enforces deploy isolation by asserting each GitHub Environment only contains
 * secrets/vars that are allowed for its surface (SSOT: config/ci/deploy-surfaces.json).
 *
 * This is a key enterprise control: deployments must not have cross-surface credentials.
 *
 * Notes:
 * - Only key names are inspected (GitHub does not allow reading secret values).
 * - Approval-only environments must contain zero secrets/vars.
 *
 * Modes:
 * - warn: print violations, exit 0
 * - enforce: print violations, exit 1
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  loadDeploySurfaceRegistry,
  compileRegistry,
  listSurfaceIds,
  getSurfaceById,
  keyAllowed,
  compileKeyPatterns,
} = require('./deploy-surface-registry');

const LEGACY_ENV_ALIAS_PATTERN = /(?:-(?:staging|production)$)|(?:^(?:staging|production)-approval(?:$|-))/i;
const repoRoot = path.resolve(__dirname, '..', '..', '..');

function die(msg) {
  console.error(`[env-isolation-lint] ${msg}`);
  process.exit(1);
}

function normalizeMode(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return 'warn';
  if (raw === 'enforce' || raw === 'error' || raw === 'fail') return 'enforce';
  if (raw === 'warn' || raw === 'warning') return 'warn';
  if (raw === 'off' || raw === 'skip' || raw === 'disabled') return 'off';
  die(`Invalid --mode: ${raw} (expected warn|enforce|off)`);
}

function parseArgs(argv) {
  const out = { repo: '', config: '', mode: '', env: '', 'env-policy': '' };
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] || '').trim();
    if (!a) continue;
    if (a === '--repo') out.repo = String(args[++i] || '').trim();
    else if (a.startsWith('--repo=')) out.repo = a.split('=').slice(1).join('=').trim();
    else if (a === '--config') out.config = String(args[++i] || '').trim();
    else if (a.startsWith('--config=')) out.config = a.split('=').slice(1).join('=').trim();
    else if (a === '--mode') out.mode = String(args[++i] || '').trim();
    else if (a.startsWith('--mode=')) out.mode = a.split('=').slice(1).join('=').trim();
    else if (a === '--env') out.env = String(args[++i] || '').trim();
    else if (a.startsWith('--env=')) out.env = a.split('=').slice(1).join('=').trim();
    else if (a === '--env-policy') out['env-policy'] = String(args[++i] || '').trim();
    else if (a.startsWith('--env-policy=')) out['env-policy'] = a.split('=').slice(1).join('=').trim();
  }
  return out;
}

function normalizeList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function compileUnmanagedEnvironmentPolicy(rawPolicy) {
  const raw = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const allowNames = normalizeList(raw.allow_unmanaged_environment_names);
  const allowNamePatterns = normalizeList(raw.allow_unmanaged_environment_name_patterns);
  const allowLegacyAliasNames = normalizeList(raw.allow_legacy_environment_alias_names);
  const allowNamesExact = new Set(allowNames);
  const allowLegacyAliasSet = new Set(allowLegacyAliasNames);
  const allowNamesRegex = allowNamePatterns.map((pattern) => {
    const source = pattern.startsWith('re:') ? pattern.slice('re:'.length) : pattern;
    try {
      return new RegExp(source);
    } catch (e) {
      die(`Invalid unmanaged env allowlist regex "${pattern}": ${e.message}`);
    }
  });
  return {
    allowNames,
    allowNamePatterns,
    allowLegacyAliasNames,
    allowNamesExact,
    allowLegacyAliasSet,
    allowNamesRegex,
  };
}

function normalizeExtraKeyEntry(entry, { context }) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    die(`Invalid extra key policy at ${context} (expected object with vars/secrets arrays).`);
  }
  const vars = normalizeList(entry.vars);
  const secrets = normalizeList(entry.secrets);
  return {
    vars,
    secrets,
    varsCompiled: compileKeyPatterns(vars, { context: `${context}.vars` }),
    secretsCompiled: compileKeyPatterns(secrets, { context: `${context}.secrets` }),
  };
}

function compileExtraKeyPolicy(rawPolicy) {
  const raw = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const byEnv = new Map();
  const byEnvPattern = [];

  const byEnvRaw = raw.allow_extra_keys_by_environment;
  if (byEnvRaw != null) {
    if (!byEnvRaw || typeof byEnvRaw !== 'object' || Array.isArray(byEnvRaw)) {
      die('Invalid allow_extra_keys_by_environment policy (expected object keyed by env name).');
    }
    for (const [envNameRaw, entry] of Object.entries(byEnvRaw)) {
      const envName = String(envNameRaw || '').trim();
      if (!envName) continue;
      byEnv.set(envName, normalizeExtraKeyEntry(entry, { context: `allow_extra_keys_by_environment.${envName}` }));
    }
  }

  const byPatternRaw = raw.allow_extra_keys_by_environment_patterns;
  if (byPatternRaw != null) {
    if (!Array.isArray(byPatternRaw)) {
      die('Invalid allow_extra_keys_by_environment_patterns policy (expected array).');
    }
    for (let i = 0; i < byPatternRaw.length; i++) {
      const row = byPatternRaw[i];
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        die(`Invalid allow_extra_keys_by_environment_patterns[${i}] (expected object).`);
      }
      const patternSource = String(row.env_name_pattern || '').trim();
      if (!patternSource) {
        die(`Missing env_name_pattern at allow_extra_keys_by_environment_patterns[${i}]`);
      }
      let envRegex = null;
      try {
        envRegex = new RegExp(patternSource);
      } catch (e) {
        die(`Invalid env_name_pattern at allow_extra_keys_by_environment_patterns[${i}]: ${e.message}`);
      }
      const normalized = normalizeExtraKeyEntry(row, {
        context: `allow_extra_keys_by_environment_patterns[${i}]`,
      });
      byEnvPattern.push({
        envRegex,
        vars: normalized.vars,
        secrets: normalized.secrets,
        varsCompiled: normalized.varsCompiled,
        secretsCompiled: normalized.secretsCompiled,
      });
    }
  }

  return { byEnv, byEnvPattern };
}

function mergeKeyPatternCompilers(base, extra, { context }) {
  const baseSafe = base && typeof base === 'object' ? base : { exact: new Set(), regex: [], raw: [] };
  const extraSafe = extra && typeof extra === 'object' ? extra : { exact: new Set(), regex: [], raw: [] };
  const raw = Array.from(
    new Set([...(Array.isArray(baseSafe.raw) ? baseSafe.raw : []), ...(Array.isArray(extraSafe.raw) ? extraSafe.raw : [])]),
  );
  return compileKeyPatterns(raw, { context });
}

function resolveEnvExtraKeyAllowances(envName, compiledPolicy) {
  const name = String(envName || '').trim();
  if (!name || !compiledPolicy) {
    return {
      varsCompiled: compileKeyPatterns([], { context: 'allow_extra_keys_by_environment.<none>.vars' }),
      secretsCompiled: compileKeyPatterns([], { context: 'allow_extra_keys_by_environment.<none>.secrets' }),
      varsRaw: [],
      secretsRaw: [],
    };
  }

  const varRaw = [];
  const secretRaw = [];
  const byEnv = compiledPolicy.byEnv instanceof Map ? compiledPolicy.byEnv : new Map();
  const byEnvPattern = Array.isArray(compiledPolicy.byEnvPattern) ? compiledPolicy.byEnvPattern : [];

  const exact = byEnv.get(name);
  if (exact) {
    varRaw.push(...(Array.isArray(exact.vars) ? exact.vars : []));
    secretRaw.push(...(Array.isArray(exact.secrets) ? exact.secrets : []));
  }

  for (const row of byEnvPattern) {
    const re = row?.envRegex;
    if (!(re instanceof RegExp) || !re.test(name)) continue;
    varRaw.push(...(Array.isArray(row.vars) ? row.vars : []));
    secretRaw.push(...(Array.isArray(row.secrets) ? row.secrets : []));
  }

  const varsRaw = Array.from(new Set(varRaw));
  const secretsRaw = Array.from(new Set(secretRaw));

  return {
    varsCompiled: compileKeyPatterns(varsRaw, { context: `allow_extra_keys_by_environment.${name}.vars` }),
    secretsCompiled: compileKeyPatterns(secretsRaw, { context: `allow_extra_keys_by_environment.${name}.secrets` }),
    varsRaw,
    secretsRaw,
  };
}

function resolveEnvPolicyPath(policyPathArg) {
  const raw = String(policyPathArg || '').trim() || 'config/ci/environment-drift-policy.json';
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

function loadEnvironmentDriftPolicy({ policyPath } = {}) {
  const filePath = resolveEnvPolicyPath(policyPath);
  if (!fs.existsSync(filePath)) {
    die(`Missing unmanaged environment policy file: ${path.relative(repoRoot, filePath)}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(fs.readFileSync(filePath, 'utf8') || '').replace(/^\uFEFF/, ''));
  } catch (e) {
    die(`Invalid JSON in unmanaged environment policy (${path.relative(repoRoot, filePath)}): ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    die(`Invalid unmanaged environment policy shape: ${path.relative(repoRoot, filePath)}`);
  }
  if (parsed.version !== 1) {
    die(
      `Unsupported unmanaged environment policy version in ${path.relative(repoRoot, filePath)}: ` +
      `${String(parsed.version || '<missing>')} (expected 1)`,
    );
  }
  const compiled = compileUnmanagedEnvironmentPolicy(parsed);
  const compiledExtraKeyPolicy = compileExtraKeyPolicy(parsed);
  return {
    ...compiled,
    compiledExtraKeyPolicy,
    filePath,
  };
}

function isUnmanagedEnvironmentAllowed(envName, compiledPolicy) {
  const name = String(envName || '').trim();
  if (!name) return false;
  if (!compiledPolicy) return false;
  if (compiledPolicy.allowNamesExact.has(name)) return true;
  for (const re of compiledPolicy.allowNamesRegex) {
    if (re.test(name)) return true;
  }
  return false;
}

function collectEnvironmentCatalogViolations({
  expectedEnvs,
  actualEnvs,
  unmanagedPolicy,
  includeUnmanaged = true,
}) {
  const expectedSet = new Set(normalizeList(expectedEnvs));
  const actualList = Array.from(new Set(normalizeList(actualEnvs))).sort();
  const violations = [];

  for (const expected of expectedSet) {
    if (!actualList.includes(expected)) {
      violations.push({
        env: expected,
        kind: 'missing_environment',
      });
    }
  }

  if (!includeUnmanaged) return violations;

  for (const actual of actualList) {
    if (expectedSet.has(actual)) continue;
    if (LEGACY_ENV_ALIAS_PATTERN.test(actual)) {
      if (unmanagedPolicy?.allowLegacyAliasSet?.has(actual)) continue;
      violations.push({
        env: actual,
        kind: 'legacy_environment_alias',
      });
      continue;
    }
    if (isUnmanagedEnvironmentAllowed(actual, unmanagedPolicy)) continue;
    violations.push({
      env: actual,
      kind: 'unexpected_unmanaged_environment',
    });
  }

  return violations;
}

function ghJson(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || '').trim() || String(res.status);
    throw new Error(msg);
  }
  const raw = String(res.stdout || '').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function listEnvSecrets(repo, envName) {
  const payload = ghJson(['secret', 'list', '--repo', repo, '--env', envName, '--json', 'name']);
  const arr = Array.isArray(payload) ? payload : [];
  return arr.map((s) => String(s?.name || '').trim()).filter(Boolean).sort();
}

function listEnvVars(repo, envName) {
  const payload = ghJson(['variable', 'list', '--repo', repo, '--env', envName, '--json', 'name']);
  const arr = Array.isArray(payload) ? payload : [];
  return arr.map((v) => String(v?.name || '').trim()).filter(Boolean).sort();
}

function getEnvRequiredReviewerCount(repo, envName) {
  const payload = ghJson(['api', `repos/${repo}/environments/${envName}`]);
  const rules = Array.isArray(payload?.protection_rules) ? payload.protection_rules : [];
  for (const rule of rules) {
    if (String(rule?.type || '').trim().toLowerCase() !== 'required_reviewers') continue;
    const users = Array.isArray(rule?.reviewers) ? rule.reviewers : [];
    const teams = Array.isArray(rule?.teams) ? rule.teams : [];
    return users.length + teams.length;
  }
  return 0;
}

function listRepoEnvironments(repo) {
  const names = [];
  let page = 1;
  while (page <= 10) {
    const payload = ghJson(['api', `repos/${repo}/environments?per_page=100&page=${page}`]);
    const batch = Array.isArray(payload?.environments) ? payload.environments : [];
    for (const env of batch) {
      const name = String(env?.name || '').trim();
      if (name) names.push(name);
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return Array.from(new Set(names)).sort();
}

function buildEnvPolicyMap(compiled, { extraKeyPolicy } = {}) {
  const map = new Map();

  function upsert(envName, policy) {
    const name = String(envName || '').trim();
    if (!name) return;
    const existing = map.get(name);
    if (!existing) {
      map.set(name, policy);
      return;
    }

    // If the same env is referenced multiple times, policies must match (SSOT).
    const aSecrets = existing.allowedSecretsRaw.join('|');
    const bSecrets = policy.allowedSecretsRaw.join('|');
    const aVars = existing.allowedVarsRaw.join('|');
    const bVars = policy.allowedVarsRaw.join('|');
    const aReview = existing.requireReviewers === true ? '1' : '0';
    const bReview = policy.requireReviewers === true ? '1' : '0';
    if (aSecrets !== bSecrets || aVars !== bVars || aReview !== bReview) {
      die(
        [
          `Conflicting allowlists for env '${name}'.`,
          `Existing: secrets=[${existing.allowedSecretsRaw.join(', ')}] vars=[${existing.allowedVarsRaw.join(', ')}]`,
          `Next: secrets=[${policy.allowedSecretsRaw.join(', ')}] vars=[${policy.allowedVarsRaw.join(', ')}]`,
          `Existing reviewers_required=${aReview} Next reviewers_required=${bReview}`,
        ].join('\n'),
      );
    }
  }

  const surfaceIds = listSurfaceIds(compiled);
  for (const surfaceId of surfaceIds) {
    const surface = getSurfaceById(compiled, surfaceId);
    if (!surface) continue;

    // Deploy envs
    const stages = Array.isArray(surface?.deploy?.stages) ? surface.deploy.stages : [];
    for (const stage of stages) {
      const envName = String(surface?.env?.deploy_env_name_by_stage?.[stage] || '').trim();
      if (!envName) continue;
      const extras = resolveEnvExtraKeyAllowances(envName, extraKeyPolicy);
      const allowedSecretsCompiled = mergeKeyPatternCompilers(
        surface.allowedSecrets,
        extras.secretsCompiled,
        { context: `surface:${surfaceId}.env:${envName}.allowed_secrets` },
      );
      const allowedVarsCompiled = mergeKeyPatternCompilers(
        surface.allowedVars,
        extras.varsCompiled,
        { context: `surface:${surfaceId}.env:${envName}.allowed_vars` },
      );
      upsert(envName, {
        envName,
        surfaceId,
        kind: 'deploy',
        stage,
        requireReviewers: false,
        allowedSecretsCompiled,
        allowedVarsCompiled,
        allowedSecretsRaw: allowedSecretsCompiled.raw || [],
        allowedVarsRaw: allowedVarsCompiled.raw || [],
      });
    }

    // Checks envs (same policy as deploy env)
    const checksByStage = surface?.env?.checks_env_name_by_stage && typeof surface.env.checks_env_name_by_stage === 'object'
      ? surface.env.checks_env_name_by_stage
      : {};
    for (const [stage, envNameRaw] of Object.entries(checksByStage)) {
      const envName = String(envNameRaw || '').trim();
      if (!envName) continue;
      const extras = resolveEnvExtraKeyAllowances(envName, extraKeyPolicy);
      const allowedSecretsCompiled = mergeKeyPatternCompilers(
        surface.allowedSecrets,
        extras.secretsCompiled,
        { context: `surface:${surfaceId}.checks_env:${envName}.allowed_secrets` },
      );
      const allowedVarsCompiled = mergeKeyPatternCompilers(
        surface.allowedVars,
        extras.varsCompiled,
        { context: `surface:${surfaceId}.checks_env:${envName}.allowed_vars` },
      );
      upsert(envName, {
        envName,
        surfaceId,
        kind: `checks:${stage}`,
        stage,
        requireReviewers: false,
        allowedSecretsCompiled,
        allowedVarsCompiled,
        allowedSecretsRaw: allowedSecretsCompiled.raw || [],
        allowedVarsRaw: allowedVarsCompiled.raw || [],
      });
    }

    // Approval envs: must contain zero secrets/vars.
    const approvalCommit = surface?.env?.approval_env_commit_by_stage && typeof surface.env.approval_env_commit_by_stage === 'object'
      ? surface.env.approval_env_commit_by_stage
      : {};
    const approvalSurface = surface?.env?.approval_env_surface_by_stage && typeof surface.env.approval_env_surface_by_stage === 'object'
      ? surface.env.approval_env_surface_by_stage
      : {};

    for (const [stage, envNameRaw] of Object.entries(approvalCommit)) {
      const envName = String(envNameRaw || '').trim();
      if (!envName) continue;
      const stageNorm = String(stage || '').trim().toLowerCase();
      upsert(envName, {
        envName,
        surfaceId,
        kind: 'approval:commit',
        stage: stageNorm,
        requireReviewers: stageNorm === 'prod',
        allowedSecretsCompiled: { exact: new Set(), regex: [], raw: [] },
        allowedVarsCompiled: { exact: new Set(), regex: [], raw: [] },
        allowedSecretsRaw: [],
        allowedVarsRaw: [],
      });
    }
    for (const [stage, envNameRaw] of Object.entries(approvalSurface)) {
      const envName = String(envNameRaw || '').trim();
      if (!envName) continue;
      const stageNorm = String(stage || '').trim().toLowerCase();
      upsert(envName, {
        envName,
        surfaceId,
        kind: 'approval:surface',
        stage: stageNorm,
        requireReviewers: stageNorm === 'prod',
        allowedSecretsCompiled: { exact: new Set(), regex: [], raw: [] },
        allowedVarsCompiled: { exact: new Set(), regex: [], raw: [] },
        allowedSecretsRaw: [],
        allowedVarsRaw: [],
      });
    }
  }

  return map;
}

function lintKeySet(keys, allowCompiled) {
  const arr = Array.isArray(keys) ? keys : [];
  const extra = [];
  for (const k of arr) {
    if (!keyAllowed(k, allowCompiled)) extra.push(k);
  }
  return extra;
}

async function main() {
  const args = parseArgs();
  const mode = normalizeMode(args.mode || process.env.ENV_ISOLATION_LINT_MODE || 'warn');
  if (mode === 'off') {
    console.log('[env-isolation-lint] Skipping (mode=off).');
    return;
  }

  const repo = String(args.repo || '').trim() || String(process.env.GITHUB_REPOSITORY || '').trim();
  if (!repo || !repo.includes('/')) die('Missing --repo and GITHUB_REPOSITORY not set (expected owner/repo).');

  const { registry } = loadDeploySurfaceRegistry({ configPath: args.config });
  const compiled = compileRegistry(registry);
  const unmanagedPolicy = loadEnvironmentDriftPolicy({ policyPath: args['env-policy'] });
  const envPolicy = buildEnvPolicyMap(compiled, { extraKeyPolicy: unmanagedPolicy.compiledExtraKeyPolicy });

  const onlyEnv = String(args.env || '').trim();
  const envNames = onlyEnv ? [onlyEnv] : Array.from(envPolicy.keys()).sort();
  const repoEnvNames = listRepoEnvironments(repo);
  const violations = collectEnvironmentCatalogViolations({
    expectedEnvs: envNames,
    actualEnvs: repoEnvNames,
    unmanagedPolicy,
    includeUnmanaged: !onlyEnv,
  }).map((entry) => ({
    ...entry,
    extra_secrets: [],
    extra_vars: [],
  }));
  const missingEnvSet = new Set(
    violations
      .filter((entry) => entry.kind === 'missing_environment')
      .map((entry) => entry.env),
  );

  for (const envName of envNames) {
    if (missingEnvSet.has(envName)) continue;
    const policy = envPolicy.get(envName);
    if (!policy) {
      violations.push({ env: envName, kind: 'unknown', extra_secrets: [], extra_vars: [] });
      continue;
    }

    let secrets = [];
    let vars = [];
    try {
      secrets = listEnvSecrets(repo, envName);
    } catch (e) {
      violations.push({
        env: envName,
        kind: policy.kind,
        error: `Unable to list env secrets: ${e.message}`,
        extra_secrets: [],
        extra_vars: [],
      });
      continue;
    }
    try {
      vars = listEnvVars(repo, envName);
    } catch (e) {
      violations.push({
        env: envName,
        kind: policy.kind,
        error: `Unable to list env vars: ${e.message}`,
        extra_secrets: [],
        extra_vars: [],
      });
      continue;
    }

    const extraSecrets = lintKeySet(secrets, policy.allowedSecretsCompiled);
    const extraVars = lintKeySet(vars, policy.allowedVarsCompiled);
    let requiredReviewerCount = 0;
    try {
      requiredReviewerCount = getEnvRequiredReviewerCount(repo, envName);
    } catch (e) {
      violations.push({
        env: envName,
        kind: policy.kind,
        error: `Unable to read environment protection rules: ${e.message}`,
        extra_secrets: [],
        extra_vars: [],
      });
      continue;
    }

    const reviewerViolation = policy.requireReviewers ? requiredReviewerCount < 1 : requiredReviewerCount > 0;
    if (extraSecrets.length || extraVars.length || reviewerViolation) {
      violations.push({
        env: envName,
        kind: policy.kind,
        surface_id: policy.surfaceId,
        reviewers_expected: policy.requireReviewers ? '>=1' : '0',
        reviewers_actual: requiredReviewerCount,
        extra_secrets: extraSecrets,
        extra_vars: extraVars,
      });
    }
  }

  if (violations.length === 0) {
    console.log(`[env-isolation-lint] OK: ${envNames.length} environment(s) validated.`);
    return;
  }

  const lines = [];
  lines.push(`[env-isolation-lint] Found ${violations.length} environment isolation violation(s).`);
  for (const v of violations) {
    const extraSecrets = Array.isArray(v.extra_secrets) ? v.extra_secrets : [];
    const extraVars = Array.isArray(v.extra_vars) ? v.extra_vars : [];
    const header = `- env=${v.env} kind=${v.kind}${v.surface_id ? ` surface=${v.surface_id}` : ''}`;
    lines.push(header);
    if (v.error) lines.push(`  error=${v.error}`);
    if (v.reviewers_expected != null) lines.push(`  reviewers_expected=${v.reviewers_expected} reviewers_actual=${v.reviewers_actual}`);
    if (extraSecrets.length) lines.push(`  extra_secrets=${extraSecrets.join(', ')}`);
    if (extraVars.length) lines.push(`  extra_vars=${extraVars.join(', ')}`);
  }
  const msg = lines.join('\n');

  if (mode === 'warn') {
    console.warn(msg);
    return;
  }

  die(msg);
}

if (require.main === module) {
  // eslint-disable-next-line promise/prefer-await-to-then
  Promise.resolve(main()).catch((e) => die(e && e.message ? e.message : String(e)));
}

module.exports = {
  normalizeMode,
  listRepoEnvironments,
  buildEnvPolicyMap,
  compileExtraKeyPolicy,
  resolveEnvExtraKeyAllowances,
  mergeKeyPatternCompilers,
  compileUnmanagedEnvironmentPolicy,
  loadEnvironmentDriftPolicy,
  isUnmanagedEnvironmentAllowed,
  collectEnvironmentCatalogViolations,
};
