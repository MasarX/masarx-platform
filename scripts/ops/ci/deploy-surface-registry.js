#!/usr/bin/env node
/**
 * deploy-surface-registry.js
 *
 * SSOT registry for deploy surfaces and their governance:
 * - Path classification (which surfaces changed)
 * - Environment names per surface/stage
 * - Approval gate environment names (commit-level vs surface-level)
 * - Allowed GitHub Environment secret/variable keys (for isolation lint)
 *
 * This file is intentionally dependency-free so it can run in CI fast checks.
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const {
  STAGE_STG,
  STAGE_PROD,
  STAGES_ALL,
} = require('./stage-contract');

const PREVIEW_TOPOLOGIES = Object.freeze(['pr', 'worktree']);
const PREVIEW_PROVIDERS = Object.freeze(['supabase', 'vercel', 'cloudflare', 'expo', 'pages']);
const PREVIEW_PROVISION_PHASES = Object.freeze(['runtime', 'hosted']);
const UI_E2E_PROFILES = Object.freeze(['gate', 'full']);
const APPROVAL_MODES = Object.freeze(['none', 'commit', 'surface']);

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function die(msg) {
  throw new Error(`[deploy-surface-registry] ${msg}`);
}

function exitWithError(error) {
  const message = error && error.message ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

function normalizePath(p) {
  return String(p || '').trim().replace(/\\/g, '/');
}

function matchesAny(reList, text) {
  const list = Array.isArray(reList) ? reList : [];
  const value = String(text || '');
  for (const re of list) {
    if (re && re.test(value)) return true;
  }
  return false;
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    // Strip UTF-8 BOM if present.
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    return null;
  }
}

function writeGithubOutput(kv) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) die('GITHUB_OUTPUT not set; run with --format json locally.');
  const lines = [];
  for (const [k, v] of Object.entries(kv)) {
    lines.push(`${k}=${String(v == null ? '' : v)}`);
  }
  fs.appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

function compileRegexList(list, { context }) {
  const raw = Array.isArray(list) ? list : [];
  const out = [];
  for (const pattern of raw) {
    const s = String(pattern || '').trim();
    if (!s) continue;
    try {
      out.push(new RegExp(s));
    } catch (e) {
      die(`Invalid regex in ${context}: "${s}" (${e.message})`);
    }
  }
  return out;
}

function normalizeKeyPatternList(list) {
  const raw = Array.isArray(list) ? list : [];
  return raw
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('re:') ? `re:${s.slice('re:'.length)}` : s));
}

function compileKeyPatterns(patterns, { context }) {
  const raw = normalizeKeyPatternList(patterns);
  const exact = new Set();
  const regex = [];
  for (const entry of raw) {
    if (entry.startsWith('re:')) {
      const pat = entry.slice('re:'.length);
      try {
        regex.push(new RegExp(pat));
      } catch (e) {
        die(`Invalid key regex in ${context}: "${entry}" (${e.message})`);
      }
      continue;
    }
    exact.add(entry);
  }
  return { exact, regex, raw };
}

function keyAllowed(key, compiled) {
  const k = String(key || '').trim();
  if (!k) return false;
  if (compiled.exact.has(k)) return true;
  for (const re of compiled.regex) {
    if (re.test(k)) return true;
  }
  return false;
}

function normalizeStringArray(list) {
  const raw = Array.isArray(list) ? list : [];
  return raw.map((v) => String(v || '').trim()).filter(Boolean);
}

function normalizeImpactId(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function normalizeSuiteId(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function compileCiSuites(list) {
  return Array.from(new Set(normalizeStringArray(list).map(normalizeSuiteId).filter(Boolean)));
}

function compileImpactTags(list) {
  return Array.from(new Set(normalizeStringArray(list).map(normalizeImpactId).filter(Boolean)));
}

function validatePreviewContract(surface, surfaceId) {
  const preview = surface?.preview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    die(`Surface "${surfaceId}" missing preview contract`);
  }

  const topologies = normalizeStringArray(preview.topologies_supported);
  if (!topologies.length) {
    die(`Surface "${surfaceId}" missing preview.topologies_supported`);
  }
  const invalidTopologies = topologies.filter((v) => !PREVIEW_TOPOLOGIES.includes(v));
  if (invalidTopologies.length) {
    die(
      `Surface "${surfaceId}" has invalid preview.topologies_supported values: ${invalidTopologies.join(', ')}`,
    );
  }
  for (const requiredTopology of PREVIEW_TOPOLOGIES) {
    if (!topologies.includes(requiredTopology)) {
      die(`Surface "${surfaceId}" preview.topologies_supported must include "${requiredTopology}"`);
    }
  }

  const provider = String(preview.provider || '').trim();
  if (!PREVIEW_PROVIDERS.includes(provider)) {
    die(
      `Surface "${surfaceId}" has invalid preview.provider "${provider || '<missing>'}" ` +
      `(expected ${PREVIEW_PROVIDERS.join('|')})`,
    );
  }

  const provisionPhase = String(preview.provision_phase || '').trim().toLowerCase();
  if (!PREVIEW_PROVISION_PHASES.includes(provisionPhase)) {
    die(
      `Surface "${surfaceId}" has invalid preview.provision_phase ` +
      `"${provisionPhase || '<missing>'}" (expected ${PREVIEW_PROVISION_PHASES.join('|')})`,
    );
  }

  if (typeof preview.prewarm_supported !== 'boolean') {
    die(`Surface "${surfaceId}" preview.prewarm_supported must be boolean`);
  }
  if (typeof preview.full_deploy_required_on_pr_full_mode !== 'boolean') {
    die(`Surface "${surfaceId}" preview.full_deploy_required_on_pr_full_mode must be boolean`);
  }

  const secretKeys = normalizeStringArray(preview.required_preview_secret_keys);
  if (!Array.isArray(preview.required_preview_secret_keys)) {
    die(`Surface "${surfaceId}" preview.required_preview_secret_keys must be array`);
  }
  if (secretKeys.length !== preview.required_preview_secret_keys.length) {
    die(`Surface "${surfaceId}" preview.required_preview_secret_keys must not contain empty entries`);
  }

  const varKeys = normalizeStringArray(preview.required_preview_var_keys);
  if (!Array.isArray(preview.required_preview_var_keys)) {
    die(`Surface "${surfaceId}" preview.required_preview_var_keys must be array`);
  }
  if (varKeys.length !== preview.required_preview_var_keys.length) {
    die(`Surface "${surfaceId}" preview.required_preview_var_keys must not contain empty entries`);
  }

  const smokeProfile = String(preview.smoke_check_profile || '').trim();
  if (!smokeProfile) {
    die(`Surface "${surfaceId}" preview.smoke_check_profile is required`);
  }

  const uiE2EProfileRules = Array.isArray(preview.ui_e2e_profile_rules)
    ? preview.ui_e2e_profile_rules
    : [];
  for (const [index, rule] of uiE2EProfileRules.entries()) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      die(`Surface "${surfaceId}" preview.ui_e2e_profile_rules[${index}] must be an object`);
    }
    const profile = String(rule.profile || '').trim().toLowerCase();
    if (!UI_E2E_PROFILES.includes(profile)) {
      die(
        `Surface "${surfaceId}" preview.ui_e2e_profile_rules[${index}].profile ` +
        `must be one of ${UI_E2E_PROFILES.join('|')}`,
      );
    }
    const include = Array.isArray(rule.include_re) ? rule.include_re : [];
    if (!include.length) {
      die(`Surface "${surfaceId}" preview.ui_e2e_profile_rules[${index}] missing include_re`);
    }
    compileRegexList(include, {
      context: `surface:${surfaceId}.preview.ui_e2e_profile_rules[${index}].include_re`,
    });
    compileRegexList(rule.exclude_re, {
      context: `surface:${surfaceId}.preview.ui_e2e_profile_rules[${index}].exclude_re`,
    });
  }

  const teardown = String(preview.teardown_strategy || '').trim();
  if (teardown !== 'manifest-driven') {
    die(
      `Surface "${surfaceId}" preview.teardown_strategy must be "manifest-driven" ` +
      `(got "${teardown || '<missing>'}")`,
    );
  }
}

function resolveConfigPath({ configPathArg, env = process.env } = {}) {
  const rel = normalizePath(configPathArg || env.DEPLOY_SURFACES_CONFIG || 'config/ci/deploy-surfaces.json');
  return path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
}

function loadDeploySurfaceRegistry({ configPath } = {}) {
  const filePath = resolveConfigPath({ configPathArg: configPath });
  if (!fs.existsSync(filePath)) die(`Missing config: ${normalizePath(path.relative(repoRoot, filePath))}`);
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object') die(`Invalid JSON in config: ${normalizePath(path.relative(repoRoot, filePath))}`);
  return { configPath: filePath, registry: parsed };
}

function validateRegistryShape(registry) {
  const r = registry && typeof registry === 'object' ? registry : null;
  if (!r) die('Registry is not an object');
  if (r.version !== 1) die(`Unsupported registry version: ${String(r.version || '') || '<missing>'} (expected 1)`);
  compileRegexList(r.ignored_paths_include_re, { context: 'ignored_paths_include_re' });
  const approvalDefaults = r.defaults && typeof r.defaults === 'object' && r.defaults.approval_mode_by_stage
    && typeof r.defaults.approval_mode_by_stage === 'object'
    ? r.defaults.approval_mode_by_stage
    : {};
  const defaultApprovalModeByStage = {
    [STAGE_STG]: String(approvalDefaults[STAGE_STG] || '').trim() || 'none',
    [STAGE_PROD]: String(approvalDefaults[STAGE_PROD] || '').trim() || 'surface',
  };
  for (const [stage, mode] of Object.entries(defaultApprovalModeByStage)) {
    if (!APPROVAL_MODES.includes(mode)) {
      die(`Unsupported defaults.approval_mode_by_stage.${stage} value "${mode}" (expected ${APPROVAL_MODES.join('|')})`);
    }
  }

  const ci = r.ci && typeof r.ci === 'object' && !Array.isArray(r.ci) ? r.ci : null;
  if (!ci) die('Registry missing ci block');
  const fullRelevantSuites = compileCiSuites(ci.full_relevant_suites);
  if (!fullRelevantSuites.length) {
    die('Registry ci.full_relevant_suites must be a non-empty array');
  }
  const nonSurfaceImpacts = Array.isArray(ci.non_surface_impacts) ? ci.non_surface_impacts : [];
  const requiredImpactIds = new Set(['docs', 'ci', 'shared']);
  const seenImpactIds = new Set();
  for (const [index, entry] of nonSurfaceImpacts.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      die(`Registry ci.non_surface_impacts[${index}] must be an object`);
    }
    const impactId = normalizeImpactId(entry.impact_id);
    if (!impactId) die(`Registry ci.non_surface_impacts[${index}] missing impact_id`);
    if (seenImpactIds.has(impactId)) die(`Registry ci.non_surface_impacts duplicate impact_id "${impactId}"`);
    seenImpactIds.add(impactId);

    const include = Array.isArray(entry.include_re) ? entry.include_re : [];
    if (!include.length) {
      die(`Registry ci.non_surface_impacts[${index}] missing include_re`);
    }
    compileRegexList(include, { context: `ci.non_surface_impacts[${index}].include_re` });
    compileRegexList(entry.exclude_re, { context: `ci.non_surface_impacts[${index}].exclude_re` });

    if (!compileImpactTags(entry.impact_tags).length) {
      die(`Registry ci.non_surface_impacts[${index}] missing impact_tags`);
    }
    if (!compileCiSuites(entry.required_suites).length) {
      die(`Registry ci.non_surface_impacts[${index}] missing required_suites`);
    }
    normalizeStringArray(entry.propagates_to_surface_ids);
  }
  for (const impactId of requiredImpactIds) {
    if (!seenImpactIds.has(impactId)) {
      die(`Registry ci.non_surface_impacts missing required impact_id "${impactId}"`);
    }
  }

  const surfaces = Array.isArray(r.surfaces) ? r.surfaces : [];
  if (surfaces.length === 0) die('Registry has no surfaces');

  const seen = new Set();
  for (const surface of surfaces) {
    if (!surface || typeof surface !== 'object') die('Surface entry is not an object');
    const id = String(surface.surface_id || '').trim();
    if (!id) die('Surface missing surface_id');
    if (!/^[a-z0-9_]+$/.test(id)) die(`Invalid surface_id "${id}" (expected [a-z0-9_]+)`);
    if (seen.has(id)) die(`Duplicate surface_id "${id}"`);
    seen.add(id);

    const include = Array.isArray(surface.paths_include_re) ? surface.paths_include_re : [];
    if (include.length === 0) die(`Surface "${id}" missing paths_include_re`);
    compileRegexList(include, { context: `surface:${id}.paths_include_re` });
    compileRegexList(surface.paths_exclude_re, { context: `surface:${id}.paths_exclude_re` });

    const deploy = surface.deploy && typeof surface.deploy === 'object' ? surface.deploy : null;
    if (!deploy) die(`Surface "${id}" missing deploy`);
    const stages = Array.isArray(deploy.stages) ? deploy.stages.map((s) => String(s || '').trim()).filter(Boolean) : [];
    if (stages.length === 0) die(`Surface "${id}" missing deploy.stages`);
    const entrypoint = deploy.entrypoint && typeof deploy.entrypoint === 'object' ? deploy.entrypoint : {};
    const entrypointType = String(entrypoint.type || '').trim().toLowerCase();
    const fallbackWorkflow = String(entrypoint.workflow_file || '').trim();
    const workflowByStage = entrypoint.workflow_file_by_stage && typeof entrypoint.workflow_file_by_stage === 'object'
      ? entrypoint.workflow_file_by_stage
      : {};
    const dispatchInputsByStage = entrypoint.workflow_dispatch_inputs_by_stage
      && typeof entrypoint.workflow_dispatch_inputs_by_stage === 'object'
      ? entrypoint.workflow_dispatch_inputs_by_stage
      : {};
    if (entrypointType === 'workflow') {
      for (const stage of stages) {
        if (stage !== STAGE_STG && stage !== STAGE_PROD) continue;
        const stageWorkflow = String(workflowByStage[stage] || '').trim() || fallbackWorkflow;
        if (!stageWorkflow) {
          die(`Surface "${id}" missing deploy.entrypoint workflow mapping for stage "${stage}"`);
        }

        const stageInputs = dispatchInputsByStage[stage];
        if (stageInputs == null) continue;
        if (!stageInputs || typeof stageInputs !== 'object' || Array.isArray(stageInputs)) {
          die(`Surface "${id}" has invalid workflow_dispatch_inputs_by_stage.${stage} (expected object).`);
        }
        for (const [k, v] of Object.entries(stageInputs)) {
          const key = String(k || '').trim();
          if (!key) die(`Surface "${id}" has empty workflow dispatch input key at stage "${stage}"`);
          const t = typeof v;
          if (!(t === 'string' || t === 'number' || t === 'boolean')) {
            die(`Surface "${id}" has non-scalar workflow dispatch input "${key}" at stage "${stage}"`);
          }
        }
      }
    }

    const env = surface.env && typeof surface.env === 'object' ? surface.env : null;
    if (!env) die(`Surface "${id}" missing env`);
    const deployEnv = env.deploy_env_name_by_stage && typeof env.deploy_env_name_by_stage === 'object' ? env.deploy_env_name_by_stage : null;
    if (!deployEnv) die(`Surface "${id}" missing env.deploy_env_name_by_stage`);
    for (const stage of stages) {
      const name = String(deployEnv[stage] || '').trim();
      if (!name) die(`Surface "${id}" missing env.deploy_env_name_by_stage.${stage}`);
    }

    // Approval env mappings are only required when the stage approval mode demands them.
    const approvalsCommit = env.approval_env_commit_by_stage && typeof env.approval_env_commit_by_stage === 'object'
      ? env.approval_env_commit_by_stage
      : {};
    const approvalsSurface = env.approval_env_surface_by_stage && typeof env.approval_env_surface_by_stage === 'object'
      ? env.approval_env_surface_by_stage
      : {};
    for (const stage of stages) {
      if (stage !== STAGE_STG && stage !== STAGE_PROD) continue;
      const mode = String(defaultApprovalModeByStage[stage] || '').trim();
      const c = String(approvalsCommit[stage] || '').trim();
      const s = String(approvalsSurface[stage] || '').trim();
      if (mode === 'commit' && !c) die(`Surface "${id}" missing env.approval_env_commit_by_stage.${stage}`);
      if (mode === 'surface' && !s) die(`Surface "${id}" missing env.approval_env_surface_by_stage.${stage}`);
    }

    normalizeKeyPatternList(surface.allowed_secret_keys);
    normalizeKeyPatternList(surface.allowed_var_keys);
    const surfaceCi = surface.ci && typeof surface.ci === 'object' && !Array.isArray(surface.ci)
      ? surface.ci
      : null;
    if (!surfaceCi) die(`Surface "${id}" missing ci block`);
    if (!compileImpactTags(surfaceCi.impact_tags).length) {
      die(`Surface "${id}" missing ci.impact_tags`);
    }
    if (!compileCiSuites(surfaceCi.required_suites).length) {
      die(`Surface "${id}" missing ci.required_suites`);
    }
    normalizeStringArray(surfaceCi.propagates_to_surface_ids);
    validatePreviewContract(surface, id);
  }

  const surfaceIds = new Set(surfaces.map((surface) => String(surface.surface_id || '').trim()));
  for (const surface of surfaces) {
    const surfaceId = String(surface.surface_id || '').trim();
    const stages = Array.isArray(surface?.deploy?.stages)
      ? surface.deploy.stages.map((stage) => String(stage || '').trim()).filter(Boolean)
      : [];
    const dependenciesByStage = surface?.deploy?.depends_on_surface_ids_by_stage;
    if (dependenciesByStage == null) continue;
    if (!dependenciesByStage || typeof dependenciesByStage !== 'object' || Array.isArray(dependenciesByStage)) {
      die(`Surface "${surfaceId}" deploy.depends_on_surface_ids_by_stage must be an object`);
    }
    for (const [stageName, rawDependencies] of Object.entries(dependenciesByStage)) {
      const stage = String(stageName || '').trim();
      if (!STAGES_ALL.includes(stage)) {
        die(`Surface "${surfaceId}" has dependency mapping for unknown stage "${stage || '<missing>'}"`);
      }
      if (!stages.includes(stage)) {
        die(`Surface "${surfaceId}" declares dependencies for unsupported stage "${stage}"`);
      }
      if (!Array.isArray(rawDependencies)) {
        die(`Surface "${surfaceId}" deploy.depends_on_surface_ids_by_stage.${stage} must be an array`);
      }
      const dependencies = normalizeStringArray(rawDependencies);
      if (dependencies.length !== rawDependencies.length) {
        die(`Surface "${surfaceId}" deploy.depends_on_surface_ids_by_stage.${stage} must not contain empty entries`);
      }
      for (const dependencySurfaceId of dependencies) {
        if (dependencySurfaceId === surfaceId) {
          die(`Surface "${surfaceId}" cannot depend on itself at stage "${stage}"`);
        }
        if (!surfaceIds.has(dependencySurfaceId)) {
          die(`Surface "${surfaceId}" stage "${stage}" depends on unknown surface "${dependencySurfaceId}"`);
        }
        const dependencySurface = surfaces.find((candidate) => String(candidate.surface_id || '').trim() === dependencySurfaceId);
        const dependencyStages = Array.isArray(dependencySurface?.deploy?.stages)
          ? dependencySurface.deploy.stages.map((value) => String(value || '').trim()).filter(Boolean)
          : [];
        if (!dependencyStages.includes(stage)) {
          die(`Surface "${surfaceId}" stage "${stage}" depends on surface "${dependencySurfaceId}" that does not support that stage`);
        }
      }
    }
  }
  for (const [index, entry] of nonSurfaceImpacts.entries()) {
    const targets = normalizeStringArray(entry.propagates_to_surface_ids);
    for (const target of targets) {
      if (!surfaceIds.has(target)) {
        die(`Registry ci.non_surface_impacts[${index}] references unknown surface "${target}"`);
      }
    }
  }
  for (const surface of surfaces) {
    const surfaceId = String(surface.surface_id || '').trim();
    const targets = normalizeStringArray(surface?.ci?.propagates_to_surface_ids);
    for (const target of targets) {
      if (!surfaceIds.has(target)) {
        die(`Surface "${surfaceId}" ci.propagates_to_surface_ids references unknown surface "${target}"`);
      }
    }
  }

  return true;
}

function compileRegistry(registry) {
  validateRegistryShape(registry);
  const r = registry;
  const defaults = r.defaults && typeof r.defaults === 'object' ? r.defaults : {};
  const approvalDefaults = defaults.approval_mode_by_stage && typeof defaults.approval_mode_by_stage === 'object'
    ? defaults.approval_mode_by_stage
    : {};
  const ci = r.ci && typeof r.ci === 'object' && !Array.isArray(r.ci) ? r.ci : {};

  const surfaces = r.surfaces.map((s) => {
    const id = String(s.surface_id || '').trim();
    return {
      surface_id: id,
      display_name: String(s.display_name || '').trim(),
      includePatterns: normalizeStringArray(s.paths_include_re),
      excludePatterns: normalizeStringArray(s.paths_exclude_re),
      includeRe: compileRegexList(s.paths_include_re, { context: `surface:${id}.paths_include_re` }),
      excludeRe: compileRegexList(s.paths_exclude_re, { context: `surface:${id}.paths_exclude_re` }),
      deploy: s.deploy,
      env: s.env,
      ci: {
        impact_tags: compileImpactTags(s?.ci?.impact_tags),
        requiredSuites: compileCiSuites(s?.ci?.required_suites),
        propagatesToSurfaceIds: normalizeStringArray(s?.ci?.propagates_to_surface_ids),
      },
      allowedSecrets: compileKeyPatterns(s.allowed_secret_keys, { context: `surface:${id}.allowed_secret_keys` }),
      allowedVars: compileKeyPatterns(s.allowed_var_keys, { context: `surface:${id}.allowed_var_keys` }),
      preview: {
        topologies_supported: normalizeStringArray(s.preview?.topologies_supported),
        provider: String(s.preview?.provider || '').trim(),
        provision_phase: String(s.preview?.provision_phase || '').trim().toLowerCase(),
        prewarm_supported: Boolean(s.preview?.prewarm_supported),
        full_deploy_required_on_pr_full_mode: Boolean(s.preview?.full_deploy_required_on_pr_full_mode),
        required_preview_secret_keys: normalizeStringArray(s.preview?.required_preview_secret_keys),
        required_preview_var_keys: normalizeStringArray(s.preview?.required_preview_var_keys),
        ui_e2e_profile_rules: (Array.isArray(s.preview?.ui_e2e_profile_rules)
          ? s.preview.ui_e2e_profile_rules
          : []
        ).map((rule, index) => ({
          profile: String(rule?.profile || '').trim().toLowerCase(),
          includeRe: compileRegexList(rule?.include_re, {
            context: `surface:${id}.preview.ui_e2e_profile_rules[${index}].include_re`,
          }),
          excludeRe: compileRegexList(rule?.exclude_re, {
            context: `surface:${id}.preview.ui_e2e_profile_rules[${index}].exclude_re`,
          }),
        })),
        smoke_check_profile: String(s.preview?.smoke_check_profile || '').trim(),
        teardown_strategy: String(s.preview?.teardown_strategy || '').trim(),
      },
    };
  });

  const nonSurfaceImpacts = (Array.isArray(ci.non_surface_impacts) ? ci.non_surface_impacts : []).map((entry, index) => ({
    impact_id: normalizeImpactId(entry?.impact_id),
    display_name: String(entry?.display_name || '').trim(),
    impact_tags: compileImpactTags(entry?.impact_tags),
    includePatterns: normalizeStringArray(entry?.include_re),
    excludePatterns: normalizeStringArray(entry?.exclude_re),
    includeRe: compileRegexList(entry?.include_re, { context: `ci.non_surface_impacts[${index}].include_re` }),
    excludeRe: compileRegexList(entry?.exclude_re, { context: `ci.non_surface_impacts[${index}].exclude_re` }),
    requiredSuites: compileCiSuites(entry?.required_suites),
    propagatesToSurfaceIds: normalizeStringArray(entry?.propagates_to_surface_ids),
  }));

  return {
    version: 1,
    ignoredIncludeRe: compileRegexList(r.ignored_paths_include_re, { context: 'ignored_paths_include_re' }),
    defaults: {
      approval_mode_by_stage: {
        [STAGE_STG]: String(approvalDefaults[STAGE_STG] || '').trim() || 'none',
        [STAGE_PROD]: String(approvalDefaults[STAGE_PROD] || '').trim() || 'surface',
      },
    },
    ci: {
      fullRelevantSuites: compileCiSuites(ci.full_relevant_suites),
      nonSurfaceImpacts,
    },
    surfaces,
  };
}

function listSurfaceIds(compiled) {
  return (compiled?.surfaces || []).map((s) => s.surface_id).sort();
}

function getSurfaceById(compiled, surfaceId) {
  const id = String(surfaceId || '').trim();
  return (compiled?.surfaces || []).find((s) => s.surface_id === id) || null;
}

function hasStage(surface, stage) {
  const s = String(stage || '').trim();
  if (!s) return false;
  const stages = Array.isArray(surface?.deploy?.stages)
    ? surface.deploy.stages.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  return stages.includes(s);
}

function getStageWorkflowFile(surface, stage) {
  const s = String(stage || '').trim();
  if (!s) return '';
  const entrypoint = surface?.deploy?.entrypoint && typeof surface.deploy.entrypoint === 'object'
    ? surface.deploy.entrypoint
    : {};
  const byStage = entrypoint.workflow_file_by_stage && typeof entrypoint.workflow_file_by_stage === 'object'
    ? entrypoint.workflow_file_by_stage
    : {};
  const stageFile = String(byStage[s] || '').trim();
  if (stageFile) return stageFile;
  return String(entrypoint.workflow_file || '').trim();
}

function getStageWorkflowDispatchInputs(surface, stage) {
  const s = String(stage || '').trim();
  if (!s) return {};
  const entrypoint = surface?.deploy?.entrypoint && typeof surface.deploy.entrypoint === 'object'
    ? surface.deploy.entrypoint
    : {};
  const byStage = entrypoint.workflow_dispatch_inputs_by_stage
    && typeof entrypoint.workflow_dispatch_inputs_by_stage === 'object'
    ? entrypoint.workflow_dispatch_inputs_by_stage
    : {};
  const raw = byStage[s] && typeof byStage[s] === 'object' && !Array.isArray(byStage[s]) ? byStage[s] : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (v == null) continue;
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
  }
  return out;
}

function findDeployTargetByEnvironmentName(compiled, environmentName) {
  const envName = String(environmentName || '').trim();
  if (!envName) return null;

  for (const surface of compiled?.surfaces || []) {
    const byStage = surface?.env?.deploy_env_name_by_stage
      && typeof surface.env.deploy_env_name_by_stage === 'object'
      ? surface.env.deploy_env_name_by_stage
      : {};
    for (const [stage, rawName] of Object.entries(byStage)) {
      const candidate = String(rawName || '').trim();
      if (!candidate) continue;
      if (candidate !== envName) continue;
      return {
        surface,
        surfaceId: surface.surface_id,
        stage: String(stage || '').trim(),
        environmentName: candidate,
      };
    }
  }

  return null;
}

function surfaceMatchesPath(surface, changedPath) {
  const p = normalizePath(changedPath);
  if (!p) return false;
  const include = Array.isArray(surface?.includeRe) ? surface.includeRe : [];
  const exclude = Array.isArray(surface?.excludeRe) ? surface.excludeRe : [];
  if (include.length === 0) return false;

  const included = include.some((re) => re.test(p));
  if (!included) return false;
  if (exclude.some((re) => re.test(p))) return false;
  return true;
}

function isIgnoredPath(compiled, changedPath) {
  const p = normalizePath(changedPath);
  if (!p) return false;
  const include = Array.isArray(compiled?.ignoredIncludeRe) ? compiled.ignoredIncludeRe : [];
  return include.some((re) => re.test(p));
}

function classifySurfacesForPaths(compiled, paths, { failClosed } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  const fail = failClosed == null ? true : Boolean(failClosed);
  const matchedBySurface = {};
  const matched = new Set();

  for (const raw of list) {
    const p = normalizePath(raw);
    if (!p) continue;
    let any = false;
    for (const surface of compiled.surfaces || []) {
      if (!surfaceMatchesPath(surface, p)) continue;
      any = true;
      matched.add(surface.surface_id);
      if (!matchedBySurface[surface.surface_id]) matchedBySurface[surface.surface_id] = [];
      matchedBySurface[surface.surface_id].push(p);
    }
    if (!any && isIgnoredPath(compiled, p)) {
      continue;
    }
    if (!any && fail) {
      // Unknown path: fail closed by requiring all surfaces (caller can decide).
      // Keep the path for diagnostics; do not emit a hard error here.
      if (!matchedBySurface.__unmatched) matchedBySurface.__unmatched = [];
      matchedBySurface.__unmatched.push(p);
    }
  }

  const surfaceIds = Array.from(matched).sort();
  return { surfaceIds, matchedBySurface };
}

function impactEntryMatchesPath(entry, changedPath) {
  const p = normalizePath(changedPath);
  if (!p) return false;
  const include = Array.isArray(entry?.includeRe) ? entry.includeRe : [];
  const exclude = Array.isArray(entry?.excludeRe) ? entry.excludeRe : [];
  if (!include.length) return false;
  if (!include.some((re) => re.test(p))) return false;
  if (exclude.some((re) => re.test(p))) return false;
  return true;
}

function listImpactSurfaceIds(compiled) {
  const ids = new Set();
  for (const impact of compiled?.ci?.nonSurfaceImpacts || []) {
    for (const tag of Array.isArray(impact?.impact_tags) ? impact.impact_tags : []) {
      ids.add(tag);
    }
  }
  for (const surface of compiled?.surfaces || []) {
    for (const tag of Array.isArray(surface?.ci?.impact_tags) ? surface.ci.impact_tags : []) {
      ids.add(tag);
    }
  }
  return Array.from(ids).sort();
}

function listImpactSuites(compiled) {
  const suites = new Set(Array.isArray(compiled?.ci?.fullRelevantSuites) ? compiled.ci.fullRelevantSuites : []);
  for (const impact of compiled?.ci?.nonSurfaceImpacts || []) {
    for (const suite of Array.isArray(impact?.requiredSuites) ? impact.requiredSuites : []) {
      suites.add(suite);
    }
  }
  for (const surface of compiled?.surfaces || []) {
    for (const suite of Array.isArray(surface?.ci?.requiredSuites) ? surface.ci.requiredSuites : []) {
      suites.add(suite);
    }
  }
  return Array.from(suites).sort();
}

function resolveImpactSelectionForPaths(compiled, paths, {
  unknown = false,
  forceFull = false,
  forceReason = '',
} = {}) {
  const files = Array.isArray(paths) ? paths.map(normalizePath).filter(Boolean) : [];
  const directSurfaceIds = new Set();
  const directImpactIds = new Set();
  const directImpactTags = new Set();
  const unmatchedFiles = [];
  const matchedBySurface = {};
  const matchedByImpact = {};

  for (const filePath of files) {
    let matched = false;

    for (const impact of compiled?.ci?.nonSurfaceImpacts || []) {
      if (!impactEntryMatchesPath(impact, filePath)) continue;
      matched = true;
      directImpactIds.add(impact.impact_id);
      if (!matchedByImpact[impact.impact_id]) matchedByImpact[impact.impact_id] = [];
      matchedByImpact[impact.impact_id].push(filePath);
      for (const tag of Array.isArray(impact?.impact_tags) ? impact.impact_tags : []) {
        directImpactTags.add(tag);
      }
    }

    for (const surface of compiled?.surfaces || []) {
      if (!surfaceMatchesPath(surface, filePath)) continue;
      matched = true;
      directSurfaceIds.add(surface.surface_id);
      if (!matchedBySurface[surface.surface_id]) matchedBySurface[surface.surface_id] = [];
      matchedBySurface[surface.surface_id].push(filePath);
    }

    if (!matched && isIgnoredPath(compiled, filePath)) {
      continue;
    }
    if (!matched) {
      unmatchedFiles.push(filePath);
    }
  }

  const impactedSurfaceIds = new Set(directSurfaceIds);
  const queue = Array.from(directSurfaceIds);
  for (const impactId of directImpactIds) {
    const impact = (compiled?.ci?.nonSurfaceImpacts || []).find((entry) => entry.impact_id === impactId);
    if (!impact) continue;
    for (const target of Array.isArray(impact?.propagatesToSurfaceIds) ? impact.propagatesToSurfaceIds : []) {
      if (impactedSurfaceIds.has(target)) continue;
      impactedSurfaceIds.add(target);
      queue.push(target);
    }
  }

  while (queue.length) {
    const surfaceId = queue.shift();
    const surface = getSurfaceById(compiled, surfaceId);
    if (!surface) continue;
    for (const target of Array.isArray(surface?.ci?.propagatesToSurfaceIds) ? surface.ci.propagatesToSurfaceIds : []) {
      if (impactedSurfaceIds.has(target)) continue;
      impactedSurfaceIds.add(target);
      queue.push(target);
    }
  }

  const requiredSuites = new Set();
  const impactTags = new Set(directImpactTags);

  for (const impactId of directImpactIds) {
    const impact = (compiled?.ci?.nonSurfaceImpacts || []).find((entry) => entry.impact_id === impactId);
    if (!impact) continue;
    for (const suite of Array.isArray(impact?.requiredSuites) ? impact.requiredSuites : []) {
      requiredSuites.add(suite);
    }
  }

  for (const surfaceId of impactedSurfaceIds) {
    const surface = getSurfaceById(compiled, surfaceId);
    if (!surface) continue;
    for (const suite of Array.isArray(surface?.ci?.requiredSuites) ? surface.ci.requiredSuites : []) {
      requiredSuites.add(suite);
    }
    for (const tag of Array.isArray(surface?.ci?.impact_tags) ? surface.ci.impact_tags : []) {
      impactTags.add(tag);
    }
  }

  const allSurfaceIds = listImpactSurfaceIds(compiled);
  const allSuites = listImpactSuites(compiled);
  const explicit = !unknown && !forceFull && files.length > 0 && unmatchedFiles.length === 0 && impactTags.size > 0;
  const selectionConfidence = explicit ? 'explicit' : 'unknown';
  const fallbackToFull = forceFull || !explicit;
  const selectedSuites = fallbackToFull
    ? Array.from(new Set([
      ...(Array.isArray(compiled?.ci?.fullRelevantSuites) ? compiled.ci.fullRelevantSuites : []),
      ...allSuites,
    ])).sort()
    : Array.from(requiredSuites).sort();
  const skippedSuites = allSuites.filter((suite) => !selectedSuites.includes(suite));

  const skipReasons = [];
  if (forceFull) skipReasons.push(String(forceReason || 'policy_force_full').trim() || 'policy_force_full');
  if (unknown) skipReasons.push('unknown_event');
  if (files.length === 0) skipReasons.push('no_changed_files');
  if (unmatchedFiles.length > 0) skipReasons.push('unmatched_paths');
  if (fallbackToFull) skipReasons.push('fallback_to_full');

  return {
    impactSurfaces: Array.from(impactTags).sort(),
    requiredSuites: Array.from(requiredSuites).sort(),
    selectionConfidence,
    fallbackToFull,
    skipReasons,
    changedFiles: files,
    unmatchedFiles,
    selectedSuites,
    skippedSuites,
    allSurfaceIds,
    allSuites,
    impactedSurfaceIds: Array.from(impactedSurfaceIds).sort(),
    directSurfaceIds: Array.from(directSurfaceIds).sort(),
    matchedBySurface,
    matchedByImpact,
  };
}

function resolveRequiredPreviewSurfaceIds({ compiled, surfaceIds }) {
  const ids = Array.isArray(surfaceIds) ? surfaceIds : [];
  const out = [];
  for (const surfaceId of ids) {
    const surface = getSurfaceById(compiled, surfaceId);
    if (!surface || !surface.preview || typeof surface.preview !== 'object') {
      // Unknown/malformed surface metadata should remain required (fail-closed).
      out.push(surfaceId);
      continue;
    }
    if (surface.preview.full_deploy_required_on_pr_full_mode === false) continue;
    out.push(surfaceId);
  }
  return out;
}

function resolvePreviewProvisionSurfaces({ compiled, surfaceIds }) {
  const requested = Array.isArray(surfaceIds)
    ? surfaceIds.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const selected = requested.length ? requested : ['db'];
  const runtime = new Set();
  const hosted = new Set();
  for (const surfaceId of selected) {
    const surface = getSurfaceById(compiled, surfaceId);
    if (!surface) {
      die(`Unknown preview surface "${surfaceId}" for provision phase resolution`);
    }
    const provisionPhase = String(surface?.preview?.provision_phase || 'runtime').trim().toLowerCase();
    if (provisionPhase === 'hosted') {
      hosted.add(surfaceId);
    } else {
      runtime.add(surfaceId);
    }
  }
  runtime.add('db');
  hosted.delete('db');
  return {
    runtimeSurfaceIds: Array.from(runtime).sort(),
    hostedSurfaceIds: Array.from(hosted).sort(),
    needsHostedProvision: hosted.size > 0,
  };
}

function filterSurfaceIdsForStage({ compiled, surfaceIds, stage }) {
  const stageName = String(stage || '').trim().toLowerCase();
  const ids = Array.isArray(surfaceIds) ? surfaceIds : [];
  if (!stageName) return ids;
  return ids.filter((surfaceId) => {
    const surface = getSurfaceById(compiled, surfaceId);
    return Boolean(surface && hasStage(surface, stageName));
  });
}

function resolveImpactPayloadForPaths(compiled, paths, {
  unknown = false,
  forceFull = false,
  forceReason = '',
  failClosed = true,
  stage = '',
} = {}) {
  const selection = resolveImpactSelectionForPaths(compiled, paths, {
    unknown,
    forceFull,
    forceReason,
  });
  const effectiveUnknown = Boolean(unknown || (failClosed && selection.unmatchedFiles.length > 0));
  const candidateSurfaceIds = effectiveUnknown
    ? listSurfaceIds(compiled)
    : Array.isArray(selection.impactedSurfaceIds)
      ? selection.impactedSurfaceIds
      : [];
  const surfaceIds = filterSurfaceIdsForStage({
    compiled,
    surfaceIds: candidateSurfaceIds,
    stage,
  });
  const requiredPreviewSurfaceIds = resolveRequiredPreviewSurfaceIds({
    compiled,
    surfaceIds,
  });
  const consolePortalSurfaceIds = surfaceIds.filter((surfaceId) => surfaceId === 'console' || surfaceId === 'portal');
  const fallbackReason = selection.fallbackToFull
    ? (selection.skipReasons || []).find((reason) => reason && reason !== 'fallback_to_full') || 'fallback_to_full'
    : '';

  return {
    ...selection,
    unknown: effectiveUnknown,
    stage: String(stage || '').trim().toLowerCase(),
    surfaceIds,
    requiredPreviewSurfaceIds,
    consolePortalE2EProfile: resolveUiE2EProfileForSurfaceIds(
      compiled,
      selection.matchedBySurface,
      consolePortalSurfaceIds,
    ),
    fallbackReason,
  };
}

function exportImpactMapFromCompiledRegistry(compiled) {
  const surfaceRowMap = new Map();

  function upsertSurfaceRow(row) {
    const id = String(row?.id || '').trim();
    if (!id) return;
    const existing = surfaceRowMap.get(id) || {
      id,
      include_re: [],
      exclude_re: [],
      required_suites: [],
      propagates_to: [],
    };
    existing.include_re = Array.from(new Set([
      ...existing.include_re,
      ...(Array.isArray(row?.include_re) ? row.include_re : []),
    ]));
    existing.exclude_re = Array.from(new Set([
      ...existing.exclude_re,
      ...(Array.isArray(row?.exclude_re) ? row.exclude_re : []),
    ]));
    existing.required_suites = Array.from(new Set([
      ...existing.required_suites,
      ...(Array.isArray(row?.required_suites) ? row.required_suites : []),
    ])).sort();
    existing.propagates_to = Array.from(new Set([
      ...existing.propagates_to,
      ...(Array.isArray(row?.propagates_to) ? row.propagates_to : []),
    ])).sort();
    surfaceRowMap.set(id, existing);
  }

  for (const impact of compiled?.ci?.nonSurfaceImpacts || []) {
    const impactId = String(impact?.impact_id || '').trim();
    if (!impactId) continue;
    upsertSurfaceRow({
      id: impactId,
      include_re: Array.isArray(impact?.includePatterns) ? impact.includePatterns : [],
      exclude_re: Array.isArray(impact?.excludePatterns) ? impact.excludePatterns : [],
      required_suites: Array.isArray(impact?.requiredSuites) ? impact.requiredSuites : [],
      propagates_to: Array.from(new Set(
        (Array.isArray(impact?.propagatesToSurfaceIds) ? impact.propagatesToSurfaceIds : [])
          .flatMap((surfaceId) => {
            const surface = getSurfaceById(compiled, surfaceId);
              return Array.isArray(surface?.ci?.impact_tags) ? surface.ci.impact_tags : [];
            }),
      )).sort(),
    });
  }

  for (const surface of compiled?.surfaces || []) {
    const impactTags = Array.isArray(surface?.ci?.impact_tags) ? surface.ci.impact_tags : [];
    for (const impactTag of impactTags) {
      upsertSurfaceRow({
        id: impactTag,
        include_re: Array.isArray(surface?.includePatterns) ? surface.includePatterns : [],
        exclude_re: Array.isArray(surface?.excludePatterns) ? surface.excludePatterns : [],
        required_suites: Array.isArray(surface?.ci?.requiredSuites) ? surface.ci.requiredSuites : [],
        propagates_to: Array.from(new Set(
          (Array.isArray(surface?.ci?.propagatesToSurfaceIds) ? surface.ci.propagatesToSurfaceIds : [])
            .flatMap((surfaceId) => {
              const target = getSurfaceById(compiled, surfaceId);
              return Array.isArray(target?.ci?.impact_tags) ? target.ci.impact_tags : [];
            }),
        )).sort(),
      });
    }
  }

  const surfaceRows = Array.from(surfaceRowMap.values())
    .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));

  return {
    version: 1,
    derived_from: 'config/ci/deploy-surfaces.json',
    full_relevant_suites: Array.isArray(compiled?.ci?.fullRelevantSuites)
      ? compiled.ci.fullRelevantSuites
      : [],
    surfaces: surfaceRows,
  };
}

function resolveSurfaceUiE2EProfile(surface, matchedPaths) {
  const rules = Array.isArray(surface?.preview?.ui_e2e_profile_rules)
    ? surface.preview.ui_e2e_profile_rules
    : [];
  if (!rules.length) return 'full';

  let selected = '';
  const files = Array.isArray(matchedPaths) ? matchedPaths.map(normalizePath).filter(Boolean) : [];
  for (const filePath of files) {
    for (const rule of rules) {
      if (!rule || !matchesAny(rule.includeRe, filePath)) continue;
      if (Array.isArray(rule.excludeRe) && matchesAny(rule.excludeRe, filePath)) continue;
      if (rule.profile === 'full') return 'full';
      if (rule.profile === 'gate') selected = 'gate';
    }
  }

  return selected || 'full';
}

function resolveUiE2EProfileForSurfaceIds(compiled, matchedBySurface, surfaceIds) {
  const ids = Array.isArray(surfaceIds) ? surfaceIds.map((value) => String(value || '').trim()).filter(Boolean) : [];
  if (!ids.length) return '';

  let selected = '';
  for (const surfaceId of ids) {
    const surface = getSurfaceById(compiled, surfaceId);
    if (!surface) return 'full';
    const profile = resolveSurfaceUiE2EProfile(surface, matchedBySurface?.[surfaceId] || []);
    if (profile === 'full') return 'full';
    if (profile === 'gate') selected = 'gate';
  }

  return selected || 'full';
}

function parseArgs(argv) {
  const out = { config: '', format: '', list: false, surface: '', stage: '' };
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] || '').trim();
    if (!a) continue;
    if (a === '--config') out.config = String(args[++i] || '').trim();
    else if (a.startsWith('--config=')) out.config = a.split('=').slice(1).join('=').trim();
    else if (a === '--format') out.format = String(args[++i] || '').trim();
    else if (a.startsWith('--format=')) out.format = a.split('=').slice(1).join('=').trim();
    else if (a === '--list' || a === '--list-surfaces') out.list = true;
    else if (a === '--surface') out.surface = String(args[++i] || '').trim();
    else if (a.startsWith('--surface=')) out.surface = a.split('=').slice(1).join('=').trim();
    else if (a === '--stage') out.stage = String(args[++i] || '').trim();
    else if (a.startsWith('--stage=')) out.stage = a.split('=').slice(1).join('=').trim();
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const { configPath, registry } = loadDeploySurfaceRegistry({ configPath: args.config });
  const compiled = compileRegistry(registry);
  const surfaceIds = listSurfaceIds(compiled);
  const fmt = String(args.format || '').trim().toLowerCase();

  if (args.list) {
    const out = { surface_ids: surfaceIds.join(','), count: String(surfaceIds.length) };
    if (fmt === 'github-output') writeGithubOutput(out);
    else process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  if (args.surface) {
    const surface = getSurfaceById(compiled, args.surface);
    if (!surface) die(`Unknown surface: ${args.surface}`);
    const stage = String(args.stage || '').trim();
    const deployEnv = stage ? String(surface.env?.deploy_env_name_by_stage?.[stage] || '').trim() : '';
    const approvalCommit = stage ? String(surface.env?.approval_env_commit_by_stage?.[stage] || '').trim() : '';
    const approvalSurface = stage ? String(surface.env?.approval_env_surface_by_stage?.[stage] || '').trim() : '';
    const out = {
      config_path: normalizePath(path.relative(repoRoot, configPath)),
      surface_id: surface.surface_id,
      stage,
      deploy_env: deployEnv,
      approval_env_commit: approvalCommit,
      approval_env_surface: approvalSurface,
    };
    if (fmt === 'github-output') writeGithubOutput(out);
    else process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const out = {
    config_path: normalizePath(path.relative(repoRoot, configPath)),
    version: compiled.version,
    defaults: compiled.defaults,
    surface_ids: surfaceIds,
  };

  if (fmt === 'github-output') {
    writeGithubOutput({
      config_path: out.config_path,
      surface_ids: surfaceIds.join(','),
      approval_mode_default_stg: String(compiled.defaults?.approval_mode_by_stage?.[STAGE_STG] || ''),
      approval_mode_default_prod: String(compiled.defaults?.approval_mode_by_stage?.[STAGE_PROD] || ''),
    });
    return;
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((e) => exitWithError(e));
}

module.exports = {
  repoRoot,
  normalizePath,
  normalizeKeyPatternList,
  compileKeyPatterns,
  keyAllowed,
  resolveConfigPath,
  loadDeploySurfaceRegistry,
  validateRegistryShape,
  compileRegistry,
  listSurfaceIds,
  getSurfaceById,
  hasStage,
  getStageWorkflowFile,
  getStageWorkflowDispatchInputs,
  findDeployTargetByEnvironmentName,
  surfaceMatchesPath,
  isIgnoredPath,
  classifySurfacesForPaths,
  impactEntryMatchesPath,
  listImpactSurfaceIds,
  listImpactSuites,
  resolveImpactSelectionForPaths,
  resolveImpactPayloadForPaths,
  resolveRequiredPreviewSurfaceIds,
  resolvePreviewProvisionSurfaces,
  filterSurfaceIdsForStage,
  exportImpactMapFromCompiledRegistry,
  PREVIEW_TOPOLOGIES,
  PREVIEW_PROVIDERS,
  PREVIEW_PROVISION_PHASES,
  UI_E2E_PROFILES,
  APPROVAL_MODES,
  validatePreviewContract,
  resolveSurfaceUiE2EProfile,
  resolveUiE2EProfileForSurfaceIds,
  normalizeImpactId,
  normalizeSuiteId,
};
