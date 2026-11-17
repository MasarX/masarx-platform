#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * preview-destroy.js
 *
 * Deletes deterministic per-PR preview workspaces:
 * - project mode: deletes `wk-*` Supabase projects
 * - branch mode: deletes `wk-*` Supabase branches under a configured parent
 *
 * Safe-guard: refuses to delete workspace names not starting with "wk-".
 */
const fs = require('fs');
const { loadEnv } = require('../../utils/load-env');
const { resolvePreviewSupabaseConfig } = require('./preview-supabase-config');
const {
  resolveBranchParentCandidates,
  shouldFallbackToProjectMode,
  withBranchParentFallback,
} = require('./preview-branch-parent');
const {
  deleteBranchWithRetries,
  deleteProjectWithRetries,
  findBranchByName,
  listProjects,
} = require('./supabase-api');
const {
  computeProjectName,
  extractPreviewWorkspaceFamilyName,
  isPreviewWorkspaceFamilyMatch,
} = require('./preview-name');

function die(msg) {
  console.error(`[preview-destroy] ${msg}`);
  process.exit(1);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || typeof a !== 'string') continue;
    if (a === '--pr') out.pr = argv[++i] || '';
    else if (a.startsWith('--pr=')) out.pr = a.split('=').slice(1).join('=');
    else if (a === '--name') out.name = argv[++i] || '';
    else if (a.startsWith('--name=')) out.name = a.split('=').slice(1).join('=');
    else if (a === '--delete-family') out['delete-family'] = argv[++i] || '1';
    else if (a.startsWith('--delete-family=')) out['delete-family'] = a.split('=').slice(1).join('=');
    else if (a === '--dry-run') out['dry-run'] = '1';
    else if (a === '--workspace-mode') out['workspace-mode'] = argv[++i] || '';
    else if (a.startsWith('--workspace-mode=')) out['workspace-mode'] = a.split('=').slice(1).join('=');
    else if (a === '--af38b526-f5c1-468d-88fb-86677fbe872a') out['af38b526-f5c1-468d-88fb-86677fbe872a'] = argv[++i] || '';
    else if (a.startsWith('--af38b526-f5c1-468d-88fb-86677fbe872a=')) out['af38b526-f5c1-468d-88fb-86677fbe872a'] = a.split('=').slice(1).join('=');
    else if (a === '--branch-id') out['branch-id'] = argv[++i] || '';
    else if (a.startsWith('--branch-id=')) out['branch-id'] = a.split('=').slice(1).join('=');
    else if (a === '--parent-ref') out['parent-ref'] = argv[++i] || '';
    else if (a.startsWith('--parent-ref=')) out['parent-ref'] = a.split('=').slice(1).join('=');
  }
  return out;
}

function readGithubEvent() {
  const evtPath = process.env.GITHUB_EVENT_PATH;
  if (!evtPath) return null;
  try {
    if (!fs.existsSync(evtPath)) return null;
    return JSON.parse(fs.readFileSync(evtPath, 'utf8'));
  } catch {
    return null;
  }
}

function extractPrNumber(evt) {
  if (!evt || typeof evt !== 'object') return '';
  if (evt.pull_request && evt.pull_request.number) return String(evt.pull_request.number);
  if (evt.number) return String(evt.number);
  if (evt.issue && evt.issue.number) return String(evt.issue.number);
  return '';
}

function parseEnabled(value, fallback = false) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function resolveProjectDeleteTargets({ projects, workspaceName, deleteFamily, expectedProjectRef = '' }) {
  const items = Array.isArray(projects) ? projects : [];
  const exactName = String(workspaceName || '').trim();
  const normalizedExactName = exactName.toLowerCase();
  const familyName = deleteFamily ? extractPreviewWorkspaceFamilyName(exactName) : '';
  const matches = [];
  const exactExpectedRef = String(expectedProjectRef || '').trim().toLowerCase();

  if (exactExpectedRef) {
    const expected = items.find((project) =>
      String(project?.ref || project?.project_ref || project?.id || '').trim().toLowerCase() === exactExpectedRef,
    );
    if (!expected) return { familyName: '', matches: [] };
    const observedName = String(expected?.name || '').trim();
    if (observedName.toLowerCase() !== normalizedExactName) {
      return {
        familyName: '',
        matches: [],
        identityMismatch: `project_name:${observedName || '<missing>'}:${exactName}`,
      };
    }
    return {
      familyName: '',
      matches: [{
        name: observedName,
        ref: String(expected?.ref || expected?.project_ref || expected?.id || '').trim(),
        createdAt: String(expected?.created_at || expected?.inserted_at || expected?.insertedAt || '').trim(),
      }],
    };
  }

  for (const project of items) {
    const name = String(project?.name || '').trim();
    const ref = String(project?.ref || project?.project_ref || project?.id || '').trim();
    if (!name || !ref) continue;
    const normalizedName = name.toLowerCase();
    const familyMatch = familyName
      ? isPreviewWorkspaceFamilyMatch({ name: normalizedName, familyName })
      : false;
    if (!familyMatch && normalizedName !== normalizedExactName) continue;
    matches.push({
      name,
      ref,
      createdAt: String(project?.created_at || project?.inserted_at || project?.insertedAt || '').trim(),
    });
  }

  matches.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  return {
    familyName,
    matches,
  };
}

function assertExactBranchIdentity({ branch, expectedBranchId = '', expectedProjectRef = '' }) {
  const branchId = String(branch?.branch_id || '').trim();
  const branchProjectRef = String(branch?.project_ref || '').trim().toLowerCase();
  const exactBranchId = String(expectedBranchId || '').trim();
  const exactProjectRef = String(expectedProjectRef || '').trim().toLowerCase();
  if (!branchId) throw new Error('branch_identity_missing:branch_id');
  if (exactBranchId && branchId !== exactBranchId) {
    throw new Error(`branch_identity_mismatch:branch_id:${branchId}:${exactBranchId}`);
  }
  if (exactProjectRef && branchProjectRef !== exactProjectRef) {
    throw new Error(`branch_identity_mismatch:project_ref:${branchProjectRef || '<missing>'}:${exactProjectRef}`);
  }
  return { branchId, branchProjectRef };
}

async function main() {
  loadEnv();
  const args = parseArgs();

  const evt = readGithubEvent();
  const prFromEvt = extractPrNumber(evt);
  const prNumber = String(args.pr || prFromEvt || '').trim();
  const repo = process.env.GITHUB_REPOSITORY || (evt && evt.repository && evt.repository.full_name) || '';

  const requirePreviewSecrets = process.env.GITHUB_ACTIONS === 'true' || process.env.REQUIRE_PREVIEW_SECRETS === '1';
  const cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets, required: ['token', 'orgId'] });
  if (cfg.missing.length) die(`Missing required preview Supabase config: ${cfg.missing.join(', ')}`);

  const token = cfg.token;
  const orgId = cfg.orgId;
  const requestedWorkspaceMode = String(args['workspace-mode'] || cfg.workspaceMode || 'project').trim().toLowerCase();
  if (!['project', 'branch', 'auto'].includes(requestedWorkspaceMode)) {
    die(`Invalid workspace mode '${requestedWorkspaceMode}'. Expected 'project', 'branch', or 'auto'.`);
  }
  const expectedParentRef = String(args['parent-ref'] || '').trim().toLowerCase();
  const expectedBranchId = String(args['branch-id'] || '').trim();
  const expectedProjectRef = String(args['af38b526-f5c1-468d-88fb-86677fbe872a'] || '').trim().toLowerCase();
  const branchParentCandidates = expectedParentRef ? [expectedParentRef] : resolveBranchParentCandidates({
    resolvedConfig: cfg,
    env: process.env,
  });
  if (!prNumber && !args.name) die('Missing PR number or --name');

  const workspaceName = String(args.name || '').trim() || computeProjectName({ repo, prNumber });
  const deleteFamily = parseEnabled(
    args['delete-family'],
    Boolean(prNumber),
  );
  const dryRun = parseEnabled(args['dry-run'], false);
  if (!workspaceName.startsWith('wk-')) die(`Refusing to delete non-preview workspace name: ${workspaceName}`);

  const timeoutMs = parseInt(process.env.PREVIEW_DELETE_TIMEOUT_MS || '900000', 10) || 900000;
  const intervalMs = parseInt(process.env.PREVIEW_DELETE_INTERVAL_MS || '15000', 10) || 15000;

  async function attemptBranchDelete({ strict } = {}) {
    if (!branchParentCandidates.length) {
      if (strict) {
        die('Missing branch parent project ref. Set PREVIEW_SUPABASE_BRANCH_PARENT_REF (or SUPABASE_BRANCH_PARENT_REF / SUPABASE_PARENT_PROJECT_REF / SUPABASE_PROJECT_ID).');
      }
      console.log('[preview-destroy] Auto mode: no branch parent project ref configured; skipping branch teardown.');
      return { deleted: false, found: false };
    }

    let lookup = null;
    try {
      lookup = await withBranchParentFallback({
        parentRefs: branchParentCandidates,
        actionLabel: 'find branch for teardown',
        action: async (parentProjectRef) => {
          const branch = await findBranchByName({ token, parentProjectRef, name: workspaceName });
          const branchId = String(branch?.branch_id || '').trim();
          if (!branchId) {
            const notFound = new Error(`Branch '${workspaceName}' not found under parent_ref=${parentProjectRef}`);
            notFound.status = 404;
            throw notFound;
          }
          return assertExactBranchIdentity({ branch, expectedBranchId, expectedProjectRef });
        },
      });
    } catch (err) {
      const status = Number(err?.status || 0);
      if (status === 404) {
        return { deleted: false, found: false };
      }
      if (!strict && shouldFallbackToProjectMode(err)) {
        console.warn(`[preview-destroy] Auto mode: branch teardown unavailable (${err.message}); falling back to project teardown.`);
        return { deleted: false, found: false };
      }
      throw err;
    }
    const branchId = String(lookup?.value?.branchId || '').trim();
    const branchProjectRef = String(lookup?.value?.branchProjectRef || '').trim();
    const branchParentRef = String(lookup?.parentProjectRef || '').trim();
    if (!branchId) {
      return { deleted: false, found: false };
    }

    if (dryRun) {
      console.log(`[preview-destroy] (dry-run) would delete branch '${workspaceName}' (branch_id=${branchId}, parent_ref=${branchParentRef})`);
      return { deleted: false, found: true, dry_run: true, branch_id: branchId, project_ref: branchProjectRef, parent_ref: branchParentRef };
    }

    console.log(`[preview-destroy] Deleting branch '${workspaceName}' (branch_id=${branchId}, parent_ref=${branchParentRef})`);
    await deleteBranchWithRetries(branchId, token, { timeoutMs, intervalMs });
    console.log('[preview-destroy] Deleted');
    return { deleted: true, found: true, branch_id: branchId, project_ref: branchProjectRef, parent_ref: branchParentRef };
  }

  if (requestedWorkspaceMode === 'branch') {
    const branchResult = await attemptBranchDelete({ strict: true });
    if (!branchResult.found) {
      console.log(`[preview-destroy] No branch found for '${workspaceName}' across candidate parent refs (already deleted).`);
    }
    console.log(JSON.stringify({ ok: true, mode: 'branch', workspace_name: workspaceName, ...branchResult }, null, 2));
    return;
  }

  if (requestedWorkspaceMode === 'auto') {
    const branchResult = await attemptBranchDelete({ strict: false });
    if (branchResult.deleted || (dryRun && branchResult.found)) {
      console.log(JSON.stringify({ ok: true, mode: 'branch', workspace_name: workspaceName, ...branchResult }, null, 2));
      return;
    }
    if (branchResult.found === false) {
      console.log(`[preview-destroy] Auto mode: no branch found for '${workspaceName}', checking project teardown path.`);
    }
  }

  const projects = await listProjects({ token, organizationId: orgId });
  const deleteTargets = resolveProjectDeleteTargets({
    projects,
    workspaceName,
    deleteFamily,
    expectedProjectRef,
  });
  if (deleteTargets.identityMismatch) {
    die(`project_identity_mismatch:${deleteTargets.identityMismatch}`);
  }

  if (deleteTargets.matches.length === 0) {
    console.log(`[preview-destroy] No project found for '${workspaceName}'${deleteTargets.familyName ? ` family=${deleteTargets.familyName}` : ''} (already deleted).`);
    console.log(JSON.stringify({ ok: true, mode: 'project', workspace_name: workspaceName, found: false, deleted: false, dry_run: dryRun, targets: [] }, null, 2));
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'project',
      workspace_name: workspaceName,
      found: true,
      deleted: false,
      dry_run: true,
      targets: deleteTargets.matches,
    }, null, 2));
    return;
  }

  for (const target of deleteTargets.matches) {
    console.log(
      `[preview-destroy] Deleting project '${target.name}' (project_ref=${target.ref})${deleteTargets.familyName ? ` family=${deleteTargets.familyName}` : ''}`,
    );
    await deleteProjectWithRetries(target.ref, token, {
      organizationId: orgId,
      timeoutMs,
      intervalMs,
    });
  }
  console.log(`[preview-destroy] Deleted ${deleteTargets.matches.length} project(s).`);
  console.log(JSON.stringify({
    ok: true,
    mode: 'project',
    workspace_name: workspaceName,
    found: true,
    deleted: true,
    dry_run: false,
    targets: deleteTargets.matches,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[preview-destroy] Failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  assertExactBranchIdentity,
  main,
  parseArgs,
  parseEnabled,
  resolveProjectDeleteTargets,
};
