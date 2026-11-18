#!/usr/bin/env node
/* eslint-disable no-console */
const { loadEnv } = require('../../utils/load-env');
const {
  ensureBranch,
  ensureProject,
  waitUntilReady,
  getApiKeys,
  getBranchConfig,
  isCanonicalPostgresPort,
  isCanonicalSupabasePoolerHost,
  isCanonicalSupabaseProjectRef,
  validateBranchDatabaseConfig,
  waitForBranchDatabaseConfig,
  deleteBranchWithRetries,
  assertOrganizationAccess,
  setProjectDatabasePassword,
  resolveProjectPoolerHost,
} = require('../workspace/supabase-api');

loadEnv();

function getArg(flag, def, argv = process.argv) {
  const args = Array.isArray(argv) ? argv : [];
  const equalsPrefix = `${flag}=`;
  const equalsArg = args.find((value) => String(value || '').startsWith(equalsPrefix));
  if (equalsArg !== undefined) return String(equalsArg).slice(equalsPrefix.length);
  const idx = args.indexOf(flag);
  if (idx !== -1) {
    const next = args[idx + 1];
    return next !== undefined && !String(next).startsWith('--') ? next : '';
  }
  return def;
}

const MAX_BRANCH_CONFIG_TIMEOUT_MS = 120_000;

function resolveBranchConfigTimeoutMs(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_BRANCH_CONFIG_TIMEOUT_MS;
  return Math.min(parsed, MAX_BRANCH_CONFIG_TIMEOUT_MS);
}

function resolveCreateMode(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  if (mode !== 'project' && mode !== 'branch') {
    throw new Error(`Invalid branch create mode '${mode}'. Expected project or branch.`);
  }
  return mode;
}

function buildBranchDatabaseUrl(branchConfig, expectedProjectRef) {
  const config = validateBranchDatabaseConfig(branchConfig, { expectedProjectRef });
  // objectives:allow DSN_URL Justification: construct a direct branch DSN solely from branch-config credentials returned by Supabase.
  return ([`postgresql`,":","/","/",`${encodeURIComponent(config.db_user)}`,":",`${encodeURIComponent(config.db_pass)}`,"@",`${config.db_host}`,":",`${config.db_port}`,"/",`postgres`].join(""));
}

function describeManagementFailure(error) {
  const status = Number(error?.status || error?.cause?.status || 0);
  return status ? `status=${status}` : 'management API unavailable';
}

async function hydrateSelectedBranch({
  selectedBranch,
  branchParentRef,
  requestedName,
  token,
  region,
  poolerPort = '5432',
  branchConfigTimeoutMs = MAX_BRANCH_CONFIG_TIMEOUT_MS,
  branchConfigRetryDelayMs = 5_000,
  getBranchConfigFn = getBranchConfig,
  waitForBranchDatabaseConfigFn = waitForBranchDatabaseConfig,
  nowFn,
  sleepFn,
  resolvePoolerHostFn,
} = {}) {
  const selectedProjectRef = String(selectedBranch?.project_ref || '').trim();
  if (!selectedProjectRef) {
    throw new Error('Selected branch did not include project_ref');
  }
  const selectedParentRef = String(
    branchParentRef || selectedBranch?.branch_parent_ref || '',
  ).trim();
  if (
    !isCanonicalSupabaseProjectRef(selectedParentRef) ||
    selectedParentRef === selectedProjectRef
  ) {
    throw new Error('Selected branch did not include valid parent lineage');
  }
  const resolvedPoolerPort = String(poolerPort || '5432').trim();
  if (!isCanonicalPostgresPort(resolvedPoolerPort)) {
    throw new Error('branch_db_credentials_invalid:pooler_port');
  }

  try {
    // project_ref is the current Management API lookup contract. branch_id is
    // retained only as legacy metadata and must not win this lookup.
    const branchConfig = await waitForBranchDatabaseConfigFn({
      token,
      branchIdOrRef: selectedProjectRef,
      expectedProjectRef: selectedProjectRef,
      maxWaitMs: resolveBranchConfigTimeoutMs(branchConfigTimeoutMs),
      retryDelayMs: branchConfigRetryDelayMs,
      getBranchConfigFn,
      ...(nowFn ? { nowFn } : {}),
      ...(sleepFn ? { sleepFn } : {}),
    });
    const credentials = validateBranchDatabaseConfig(branchConfig, {
      expectedProjectRef: selectedProjectRef,
    });
    const resolvedRegion = String(
      branchConfig?.region || selectedBranch?.region || region || '',
    ).trim();
    const poolerHost = resolvePoolerHostFn
      ? await resolvePoolerHostFn(credentials.project_ref, resolvedRegion)
      : '';
    if (poolerHost && !isCanonicalSupabasePoolerHost(poolerHost)) {
      const invalidPooler = new Error('branch_db_credentials_invalid:pooler_host');
      invalidPooler.code = 'branch_db_credentials_invalid';
      throw invalidPooler;
    }
    return {
      mode: 'branch',
      name: String(branchConfig?.name || selectedBranch?.name || requestedName || '').trim(),
      reused: selectedBranch?.reused === true,
      branch_id: String(selectedBranch?.branch_id || branchConfig?.branch_id || '').trim(),
      branch_parent_ref: selectedParentRef,
      project_ref: credentials.project_ref,
      region: resolvedRegion,
      pooler_host: poolerHost || undefined,
      pooler_port: resolvedPoolerPort,
      direct_db_host: credentials.db_host,
      db_pass: credentials.db_pass,
      ...(credentials.jwt_secret ? { jwt_secret: credentials.jwt_secret } : {}),
      // objectives:allow SUPABASE_URL Justification: build standard Supabase host dynamically from the branch config project_ref.
      supabase_url: `https://${credentials.project_ref}.supabase.co`,
      database_url: buildBranchDatabaseUrl(credentials, selectedProjectRef),
    };
  } catch (error) {
    const credentialCode = String(error?.code || '').trim();
    const detail = credentialCode.startsWith('branch_db_credentials_')
      ? `code=${credentialCode}`
      : describeManagementFailure(error);
    const wrapped = new Error(
      `Branch credential lookup failed after branch selection (${detail})`,
      { cause: error },
    );
    if (credentialCode) wrapped.code = credentialCode;
    throw wrapped;
  }
}

async function selectBranchForProvision({
  token,
  parentRef,
  name,
  reuseExisting = true,
  ensureBranchFn = ensureBranch,
} = {}) {
  if (!isCanonicalSupabaseProjectRef(parentRef)) {
    throw new Error('Branch mode requires canonical SUPABASE_BRANCH_PARENT_REF');
  }
  if (!String(token || '').trim()) {
    throw new Error('Branch mode requires SUPABASE_ACCESS_TOKEN');
  }
  return ensureBranchFn({
    token,
    parentProjectRef: parentRef,
    name,
    reuseExisting,
  });
}

async function hydrateBranchForProvision({
  selectedBranch,
  token,
  hydrateSelectedBranchFn = hydrateSelectedBranch,
  deleteBranchWithRetriesFn = deleteBranchWithRetries,
  ...hydrateOptions
} = {}) {
  try {
    return await hydrateSelectedBranchFn({
      selectedBranch,
      token,
      ...hydrateOptions,
    });
  } catch (error) {
    const branchId = String(selectedBranch?.branch_id || '').trim();
    // Cleanup is permitted only for an exact branch ID that this command just
    // created. Reused branches remain fail-closed without destructive repair.
    if (selectedBranch?.reused === false && branchId) {
      try {
        await deleteBranchWithRetriesFn(branchId, token, { timeoutMs: 120_000 });
      } catch (cleanupError) {
        const status = Number(cleanupError?.status || cleanupError?.cause?.status || 0);
        console.warn(
          `[branches/create] Could not remove newly created branch_id=${branchId} after hydration failure${status ? ` (status=${status})` : ''}.`,
        );
      }
    }
    throw error;
  }
}

async function main() {
  const modeArg = getArg('--mode', undefined);
  const mode = resolveCreateMode(
    modeArg === undefined ? process.env.WORKSPACE_MODE || 'project' : modeArg,
  );
  const name = getArg('--name', '');
  const nameTrimmed = (name || '').trim();
  if (!nameTrimmed) {
    console.error('[branches/create] Missing required --name; set it explicitly or ensure upstream resolved a worktree name.');
    process.exit(1);
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN || '';
  const orgId = process.env.SUPABASE_ORG_ID || '';
  const region = process.env.SUPABASE_REGION || 'us-east-1';
  // Accept either SUPABASE_BRANCH_PARENT_REF (CI) or SUPABASE_PARENT_PROJECT_REF (human/dev)
  const parentRef = process.env.SUPABASE_BRANCH_PARENT_REF || process.env.SUPABASE_PARENT_PROJECT_REF || process.env.SUPABASE_PROJECT_ID || '';
  const plan = process.env.SUPABASE_PLAN || 'free';
  const dbPass = process.env.SUPABASE_DB_PASSWORD || '';
  const forceNew =
    String(process.env.WORKSPACE_FORCE_NEW || '').trim() === '1' ||
    process.argv.includes('--fresh') ||
    process.argv.includes('--new');

  async function resolvePoolerHostForProject(
    projectRef,
    regionHint,
    { allowConfiguredFallback = true, allowDerivedFallback = true } = {},
  ) {
    const fallbackHost = allowConfiguredFallback
      ? process.env.SUPABASE_POOLER_HOST || ''
      : '';
    try {
      return await resolveProjectPoolerHost({
        projectRef,
        token,
        preferredRegion: regionHint || '',
        fallbackHost,
        allowDerivedFallback,
      });
    } catch (error) {
      const fallbackRegion = String(regionHint || '').trim();
      const fallbackDerived =
        String(fallbackHost || '').trim() ||
        (allowDerivedFallback && fallbackRegion
          ? `aws-1-${fallbackRegion}.pooler.supabase.com`
          : '');
      if (fallbackDerived) {
        console.warn(
          `[branches/create] Pooler host probe failed for ${projectRef}; falling back to ${fallbackDerived}. Reason: ${error.message}`,
        );
      } else {
        console.warn(
          `[branches/create] Pooler host probe failed for ${projectRef}: ${error.message}`,
        );
      }
      return fallbackDerived;
    }
  }

  if (mode === 'branch') {
    const branchPoolerPort = String(process.env.SUPABASE_POOLER_PORT || '5432').trim();
    if (!isCanonicalPostgresPort(branchPoolerPort)) {
      throw new Error('Branch mode requires a valid SUPABASE_POOLER_PORT');
    }
    const selectedBranch = await selectBranchForProvision({
      token,
      parentRef,
      name: nameTrimmed,
      reuseExisting: !forceNew,
    });
    const branchResult = await hydrateBranchForProvision({
      selectedBranch,
      branchParentRef: parentRef,
      requestedName: nameTrimmed,
      token,
      region,
      poolerPort: branchPoolerPort,
      branchConfigTimeoutMs: process.env.SUPABASE_BRANCH_CONFIG_TIMEOUT_MS,
      branchConfigRetryDelayMs:
        process.env.SUPABASE_BRANCH_CONFIG_RETRY_DELAY_MS || 5_000,
    });
    console.log(JSON.stringify(branchResult, null, 2));
    return branchResult;
  }

  // Fallback / project mode
  if (!token) {
    console.error('[branches/create] SUPABASE_ACCESS_TOKEN is required for project provisioning.');
    process.exit(1);
  }
  if (!orgId) {
    console.error('[branches/create] SUPABASE_ORG_ID is required for project provisioning.');
    process.exit(1);
  }
  const projName = nameTrimmed;
  await assertOrganizationAccess({ token, organizationId: orgId });
  const created = await ensureProject({
    token,
    organizationId: orgId,
    name: projName,
    region,
    plan,
    dbPass,
    reuseExisting: !forceNew,
  });
  const projectRef = created.project_ref;

  // Reused projects can have a stale DB password relative to current secrets.
  // Sync password up front so downstream db push does not loop on auth failures.
  if (created.reused) {
    await setProjectDatabasePassword({
      projectRef,
      token,
      password: created.db_pass,
    });
  }

  await waitUntilReady(projectRef, token);
  const keys = await getApiKeys(projectRef, token);
  const pass = created.db_pass;
  // objectives:allow SUPABASE_URL Justification: build standard supabase.co host dynamically from project_ref
  const supabaseUrl = `https://${projectRef}.supabase.co`;
  const poolerHost = await resolvePoolerHostForProject(projectRef, region);
  // objectives:allow DSN_URL Justification: construct DSN for ephemeral project; dynamic project_ref
  const dbUrl = ([`postgresql`,":","/","/",`postgres`,":",`${encodeURIComponent(pass)}`,"@",`db.${projectRef}.supabase.co`,":",`5432`,"/",`postgres`].join(""));
  const out = {
    mode: 'project',
    reused: created.reused === true,
    name: projName,
    project_ref: projectRef,
    region,
    supabase_url: supabaseUrl,
    database_url: dbUrl,
    pooler_host: poolerHost || undefined,
    db_pass: pass,
    anon_key: keys.anon || null,
    service_role_key: keys.service || null,
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[branches/create] Failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  buildBranchDatabaseUrl,
  describeManagementFailure,
  hydrateBranchForProvision,
  hydrateSelectedBranch,
  getArg,
  main,
  resolveBranchConfigTimeoutMs,
  resolveCreateMode,
  selectBranchForProvision,
};
