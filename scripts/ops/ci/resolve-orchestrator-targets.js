#!/usr/bin/env node
/**
 * resolve-orchestrator-targets.js
 *
 * Resolves deploy orchestrator matrix targets from deploy surface SSOT config.
 *
 * Inputs:
 * - stage: stg|prod
 * - sha: commit SHA to dispatch
 * - surfaces: comma-separated surface ids
 *
 * Outputs:
 * - commit_approval_env
 * - targets_json (matrix entries with workflow + surface approval env + dispatch inputs JSON)
 * - primary_targets_json / dependent_targets_json (same-stage deploy dependency waves)
 * - skip (1 when no targets)
 */
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const {
  loadDeploySurfaceRegistry,
  compileRegistry,
  getSurfaceById,
  hasStage,
  getStageWorkflowFile,
  getStageWorkflowDispatchInputs,
} = require('./deploy-surface-registry');
const {
  assertStage,
  STAGE_STG,
  STAGE_PROD,
  STAGES_ALL,
} = require('./stage-contract');

function die(msg) {
  console.error(`[resolve-orchestrator-targets] ${msg}`);
  process.exit(1);
}

function fail(msg) {
  throw new Error(msg);
}

function parseCsv(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return Array.from(new Set(
    text
      .split(',')
      .map((v) => String(v || '').trim())
      .filter(Boolean),
  )).sort();
}

function normalizeSurfaceIdList(list) {
  const raw = Array.isArray(list) ? list : [];
  return Array.from(new Set(
    raw
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )).sort();
}

function parseArgs(argv) {
  const out = {
    stage: '',
    surfaces: '',
    sha: '',
    config: '',
    format: '',
  };
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] || '').trim();
    if (!a) continue;
    if (a === '--stage') out.stage = String(args[++i] || '').trim();
    else if (a.startsWith('--stage=')) out.stage = a.split('=').slice(1).join('=').trim();
    else if (a === '--surfaces') out.surfaces = String(args[++i] || '').trim();
    else if (a.startsWith('--surfaces=')) out.surfaces = a.split('=').slice(1).join('=').trim();
    else if (a === '--sha') out.sha = String(args[++i] || '').trim();
    else if (a.startsWith('--sha=')) out.sha = a.split('=').slice(1).join('=').trim();
    else if (a === '--config') out.config = String(args[++i] || '').trim();
    else if (a.startsWith('--config=')) out.config = a.split('=').slice(1).join('=').trim();
    else if (a === '--format') out.format = String(args[++i] || '').trim();
    else if (a.startsWith('--format=')) out.format = a.split('=').slice(1).join('=').trim();
  }
  return out;
}

function writeGithubOutput(kv) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) die('GITHUB_OUTPUT not set; use --format json locally.');
  const lines = [];
  for (const [k, v] of Object.entries(kv)) {
    lines.push(`${k}=${String(v == null ? '' : v)}`);
  }
  fs.appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

function countIndent(rawLine) {
  const line = String(rawLine || '');
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function extractWorkflowDispatchInputKeys(workflowPath) {
  const filePath = String(workflowPath || '').trim();
  if (!filePath) fail('Missing workflow path for dispatch-input validation');
  if (!fs.existsSync(filePath)) {
    fail(`Workflow file not found for dispatch-input validation: ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let dispatchIndex = -1;
  let dispatchIndent = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!/^workflow_dispatch\s*:/.test(trimmed)) continue;
    dispatchIndex = i;
    dispatchIndent = countIndent(raw);
    break;
  }

  if (dispatchIndex < 0) {
    fail(`Workflow "${path.basename(filePath)}" does not declare workflow_dispatch`);
  }

  let inputsIndex = -1;
  let inputsIndent = 0;

  for (let i = dispatchIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = countIndent(raw);
    if (indent <= dispatchIndent) break;
    if (!/^inputs\s*:/.test(trimmed)) continue;
    inputsIndex = i;
    inputsIndent = indent;
    break;
  }

  if (inputsIndex < 0) return new Set();

  const keys = new Set();
  let keyIndent = -1;

  for (let i = inputsIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = countIndent(raw);
    if (indent <= inputsIndent) break;

    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(?:#.*)?$/);
    if (!match) continue;
    if (keyIndent < 0) keyIndent = indent;
    if (indent !== keyIndent) continue;
    keys.add(match[1]);
  }

  return keys;
}

function validateDispatchInputsAgainstWorkflow({
  workflowId,
  dispatchInputs,
  workflowRoot,
}) {
  const workflowFile = String(workflowId || '').trim();
  if (!workflowFile) fail('Missing workflow_id for dispatch-input validation');

  const repoRoot = String(workflowRoot || '').trim()
    ? path.resolve(String(workflowRoot || '').trim())
    : path.resolve(__dirname, '..', '..', '..');
  const workflowPath = path.join(repoRoot, '.github', 'workflows', workflowFile);
  const declaredInputs = extractWorkflowDispatchInputKeys(workflowPath);
  const inputKeys = Object.keys(dispatchInputs || {});
  const undeclared = inputKeys.filter((key) => !declaredInputs.has(String(key || '').trim()));
  if (undeclared.length > 0) {
    fail(
      `Workflow "${workflowFile}" does not declare workflow_dispatch input(s): ${undeclared.join(', ')}`,
    );
  }
}

function buildDependencyWaves(targets) {
  const entries = Array.isArray(targets) ? targets : [];
  const remaining = new Map(entries.map((entry) => [entry.surface_id, entry]));
  const waves = [];

  while (remaining.size > 0) {
    const ready = [];
    for (const [surfaceId, target] of remaining.entries()) {
      const dependencies = Array.isArray(target?.dependency_surface_ids)
        ? target.dependency_surface_ids
        : [];
      const blockedByRemaining = dependencies.some((dependencySurfaceId) => remaining.has(dependencySurfaceId));
      if (!blockedByRemaining) ready.push(surfaceId);
    }

    if (ready.length === 0) {
      const cycleDetails = Array.from(remaining.values()).map((target) => ({
        surface_id: target.surface_id,
        dependency_surface_ids: target.dependency_surface_ids || [],
      }));
      fail(`Deploy dependency cycle detected: ${JSON.stringify(cycleDetails)}`);
    }

    const wave = ready
      .sort()
      .map((surfaceId) => remaining.get(surfaceId));
    for (const surfaceId of ready) {
      remaining.delete(surfaceId);
    }
    waves.push(wave);
  }

  if (waves.length > 2) {
    fail(`Deploy orchestrator currently supports at most two dependency waves; resolved ${waves.length}`);
  }

  return waves;
}

function buildOutput({
  stage,
  sha,
  targetSurfaceIds,
  targets,
  commitApprovalEnv,
  approvalMode = 'none',
}) {
  const list = Array.isArray(targetSurfaceIds) ? targetSurfaceIds : [];
  const entries = Array.isArray(targets) ? targets : [];
  const waves = buildDependencyWaves(entries);
  const primaryTargets = waves[0] || [];
  const dependentTargets = waves.slice(1).flat();
  const skip = list.length === 0 ? '1' : '0';
  return {
    stage,
    deploy_sha: sha,
    surface_ids: list.join(','),
    targets_count: String(entries.length),
    targets_json: JSON.stringify(entries),
    primary_targets_count: String(primaryTargets.length),
    primary_targets_json: JSON.stringify(primaryTargets),
    dependent_targets_count: String(dependentTargets.length),
    dependent_targets_json: JSON.stringify(dependentTargets),
    has_dependent_targets: dependentTargets.length > 0 ? '1' : '0',
    target_waves_json: JSON.stringify(waves),
    commit_approval_env: commitApprovalEnv || '',
    approval_mode: String(approvalMode || '').trim() || 'none',
    skip,
  };
}

function getStageDependencySurfaceIds({ surface, stage, selectedSurfaceIds, compiled }) {
  const byStage = surface?.deploy?.depends_on_surface_ids_by_stage;
  if (!byStage || typeof byStage !== 'object' || Array.isArray(byStage)) return [];
  const configured = normalizeSurfaceIdList(byStage[stage]);
  if (!configured.length) return [];
  const selected = new Set(Array.isArray(selectedSurfaceIds) ? selectedSurfaceIds : []);
  const surfaceId = String(surface?.surface_id || '').trim();

  const dependencies = [];
  for (const dependencySurfaceId of configured) {
    if (dependencySurfaceId === surfaceId) {
      fail(`Surface "${surfaceId}" cannot depend on itself at stage "${stage}"`);
    }
    const dependencySurface = getSurfaceById(compiled, dependencySurfaceId);
    if (!dependencySurface) {
      fail(`Surface "${surfaceId}" stage "${stage}" depends on unknown surface "${dependencySurfaceId}"`);
    }
    if (!hasStage(dependencySurface, stage)) {
      fail(`Surface "${surfaceId}" stage "${stage}" depends on surface "${dependencySurfaceId}" that does not support that stage`);
    }
    if (selected.has(dependencySurfaceId)) dependencies.push(dependencySurfaceId);
  }

  return dependencies;
}

function resolveTargets({ stage, sha, surfacesCsv, configPath, workflowRoot }) {
  const s = assertStage(stage, { label: 'stage', allowed: STAGES_ALL });

  const deploySha = String(sha || '').trim();
  if (!deploySha) fail('Missing --sha');

  const targetSurfaceIds = parseCsv(surfacesCsv);
  if (targetSurfaceIds.length === 0) {
    return buildOutput({
      stage: s,
      sha: deploySha,
      targetSurfaceIds: [],
      targets: [],
      commitApprovalEnv: '',
    });
  }

  const { registry } = loadDeploySurfaceRegistry({ configPath });
  const compiled = compileRegistry(registry);
  const approvalModeByStage = compiled?.defaults?.approval_mode_by_stage || {};

  const targets = [];
  let commitApprovalEnv = '';
  let approvalMode = '';

  for (const surfaceId of targetSurfaceIds) {
    const surface = getSurfaceById(compiled, surfaceId);
    if (!surface) fail(`Unknown surface_id "${surfaceId}"`);
    if (!hasStage(surface, s)) {
      fail(`Surface "${surfaceId}" does not support stage "${s}"`);
    }

    const workflowId = getStageWorkflowFile(surface, s);
    if (!workflowId) {
      fail(`Surface "${surfaceId}" missing workflow mapping for stage "${s}"`);
    }

    const resolvedApprovalMode =
      s === STAGE_PROD
        ? String(approvalModeByStage[STAGE_PROD] || '').trim() || 'surface'
        : s === STAGE_STG
          ? String(approvalModeByStage[STAGE_STG] || '').trim() || 'none'
          : 'none';
    const approvalEnvCommit = String(surface?.env?.approval_env_commit_by_stage?.[s] || '').trim();
    const approvalEnvSurface = String(surface?.env?.approval_env_surface_by_stage?.[s] || '').trim();

    if (!approvalMode) {
      approvalMode = resolvedApprovalMode;
    } else if (approvalMode !== resolvedApprovalMode) {
      fail(`Surfaces resolve conflicting approval modes for stage "${s}": "${approvalMode}" vs "${resolvedApprovalMode}"`);
    }

    if (resolvedApprovalMode === 'commit' && !approvalEnvCommit) {
      fail(`Surface "${surfaceId}" missing approval_env_commit_by_stage.${s}`);
    }
    if (resolvedApprovalMode === 'surface' && !approvalEnvSurface) {
      fail(`Surface "${surfaceId}" missing approval_env_surface_by_stage.${s}`);
    }

    if (resolvedApprovalMode === 'commit') {
      if (!commitApprovalEnv) {
        commitApprovalEnv = approvalEnvCommit;
      } else if (commitApprovalEnv !== approvalEnvCommit) {
        fail(`Surfaces resolve conflicting commit approval envs for stage "${s}": "${commitApprovalEnv}" vs "${approvalEnvCommit}"`);
      }
    }

    const dispatchInputs = {
      ...getStageWorkflowDispatchInputs(surface, s),
      ref: deploySha,
    };
    validateDispatchInputsAgainstWorkflow({
      workflowId,
      dispatchInputs,
      workflowRoot,
    });

    const dependencySurfaceIds = getStageDependencySurfaceIds({
      surface,
      stage: s,
      selectedSurfaceIds: targetSurfaceIds,
      compiled,
    });

    targets.push({
      surface_id: surfaceId,
      workflow_id: workflowId,
      approval_env_surface: approvalEnvSurface,
      dependency_surface_ids: dependencySurfaceIds,
      dispatch_inputs_json: JSON.stringify(dispatchInputs),
    });
  }

  return buildOutput({
    stage: s,
    sha: deploySha,
    targetSurfaceIds,
    targets,
    commitApprovalEnv,
    approvalMode,
  });
}

function main() {
  const args = parseArgs();
  const out = resolveTargets({
    stage: args.stage || process.env.ORCHESTRATOR_STAGE,
    sha: args.sha || process.env.DEPLOY_SHA,
    surfacesCsv: args.surfaces || process.env.SURFACES || '',
    configPath: args.config,
  });
  const fmt = String(args.format || '').trim().toLowerCase();
  if (fmt === 'github-output') {
    writeGithubOutput(out);
    return;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    die(err && err.message ? err.message : String(err));
  }
}

module.exports = {
  parseCsv,
  parseArgs,
  buildOutput,
  extractWorkflowDispatchInputKeys,
  validateDispatchInputsAgainstWorkflow,
  buildDependencyWaves,
  getStageDependencySurfaceIds,
  resolveTargets,
};
