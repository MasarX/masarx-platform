function readEnv(key, env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : process.env;
  return String(sourceEnv[key] || '').trim();
}

const DEFAULT_DNS_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_DNS_POLL_MS = 3000;
const DEFAULT_WORKSPACE_MODE = 'project';

function parsePositiveInt(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { raw: '', value: null };
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) return { raw: trimmed, value: Number.NaN };
  return { raw: trimmed, value: Math.floor(num) };
}

function normalizeWorkspaceMode(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  if (!mode) return '';
  if (mode === 'project' || mode === 'branch' || mode === 'auto') return mode;
  return '';
}

function resolvePreviewSupabaseConfig(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const requirePreviewSecrets = options.requirePreviewSecrets === true;
  const required = Array.isArray(options.required) && options.required.length
    ? Array.from(new Set(options.required.map((v) => String(v || '').trim()).filter(Boolean)))
    : ['token', 'orgId', 'region', 'dbPass'];

  const preview = {
    token: readEnv('PREVIEW_SUPABASE_ACCESS_TOKEN', env),
    orgId: readEnv('PREVIEW_SUPABASE_ORG_ID', env),
    region: readEnv('PREVIEW_SUPABASE_REGION', env),
    plan: readEnv('PREVIEW_SUPABASE_PLAN', env),
    dbPass: readEnv('PREVIEW_SUPABASE_DB_PASSWORD', env),
    poolerHost: readEnv('PREVIEW_SUPABASE_POOLER_HOST', env),
    poolerPort: readEnv('PREVIEW_SUPABASE_POOLER_PORT', env),
    dnsTimeoutMs: readEnv('PREVIEW_SUPABASE_DNS_TIMEOUT_MS', env),
    dnsPollMs: readEnv('PREVIEW_SUPABASE_DNS_POLL_MS', env),
    workspaceMode: readEnv('PREVIEW_SUPABASE_WORKSPACE_MODE', env),
    branchParentRef: readEnv('PREVIEW_SUPABASE_BRANCH_PARENT_REF', env) || readEnv('PREVIEW_SUPABASE_PARENT_PROJECT_REF', env),
  };

  const fallback = {
    token: readEnv('SUPABASE_ACCESS_TOKEN', env),
    orgId: readEnv('SUPABASE_ORG_ID', env),
    region: readEnv('SUPABASE_REGION', env),
    plan: readEnv('SUPABASE_PLAN', env),
    dbPass: readEnv('SUPABASE_DB_PASSWORD', env),
    poolerHost: readEnv('SUPABASE_POOLER_HOST', env),
    poolerPort: readEnv('SUPABASE_POOLER_PORT', env),
    dnsTimeoutMs: readEnv('SUPABASE_DNS_TIMEOUT_MS', env),
    dnsPollMs: readEnv('SUPABASE_DNS_POLL_MS', env),
    workspaceMode: readEnv('WORKSPACE_MODE', env),
    branchParentRef: readEnv('SUPABASE_BRANCH_PARENT_REF', env) || readEnv('SUPABASE_PROJECT_ID', env) || readEnv('SUPABASE_PARENT_PROJECT_REF', env),
  };

  const invalid = [];

  const previewDnsTimeout = parsePositiveInt(preview.dnsTimeoutMs);
  if (previewDnsTimeout.raw && !Number.isFinite(previewDnsTimeout.value)) invalid.push('PREVIEW_SUPABASE_DNS_TIMEOUT_MS');
  const fallbackDnsTimeout = parsePositiveInt(fallback.dnsTimeoutMs);
  if (fallbackDnsTimeout.raw && !Number.isFinite(fallbackDnsTimeout.value)) invalid.push('SUPABASE_DNS_TIMEOUT_MS');

  const previewDnsPoll = parsePositiveInt(preview.dnsPollMs);
  if (previewDnsPoll.raw && !Number.isFinite(previewDnsPoll.value)) invalid.push('PREVIEW_SUPABASE_DNS_POLL_MS');
  const fallbackDnsPoll = parsePositiveInt(fallback.dnsPollMs);
  if (fallbackDnsPoll.raw && !Number.isFinite(fallbackDnsPoll.value)) invalid.push('SUPABASE_DNS_POLL_MS');

  const previewWorkspaceMode = normalizeWorkspaceMode(preview.workspaceMode);
  if (preview.workspaceMode && !previewWorkspaceMode) invalid.push('PREVIEW_SUPABASE_WORKSPACE_MODE');
  const fallbackWorkspaceMode = normalizeWorkspaceMode(fallback.workspaceMode);
  if (fallback.workspaceMode && !fallbackWorkspaceMode) invalid.push('WORKSPACE_MODE');

  const resolvedDnsTimeoutMs = Number.isFinite(previewDnsTimeout.value)
    ? previewDnsTimeout.value
    : Number.isFinite(fallbackDnsTimeout.value)
      ? fallbackDnsTimeout.value
      : DEFAULT_DNS_TIMEOUT_MS;

  const resolvedDnsPollMs = Number.isFinite(previewDnsPoll.value)
    ? previewDnsPoll.value
    : Number.isFinite(fallbackDnsPoll.value)
      ? fallbackDnsPoll.value
      : DEFAULT_DNS_POLL_MS;

  const resolved = {
    token: preview.token || fallback.token,
    orgId: preview.orgId || fallback.orgId,
    region: preview.region || fallback.region,
    plan: preview.plan || fallback.plan || 'free',
    dbPass: preview.dbPass || fallback.dbPass,
    poolerHost: preview.poolerHost || fallback.poolerHost,
    poolerPort: preview.poolerPort || fallback.poolerPort,
    dnsTimeoutMs: resolvedDnsTimeoutMs,
    dnsPollMs: resolvedDnsPollMs,
    workspaceMode: previewWorkspaceMode || fallbackWorkspaceMode || DEFAULT_WORKSPACE_MODE,
    branchParentRef: preview.branchParentRef || fallback.branchParentRef,
  };

  const keyToPreviewEnvVar = {
    token: 'PREVIEW_SUPABASE_ACCESS_TOKEN',
    orgId: 'PREVIEW_SUPABASE_ORG_ID',
    region: 'PREVIEW_SUPABASE_REGION',
    dbPass: 'PREVIEW_SUPABASE_DB_PASSWORD',
    poolerHost: 'PREVIEW_SUPABASE_POOLER_HOST',
    poolerPort: 'PREVIEW_SUPABASE_POOLER_PORT',
    plan: 'PREVIEW_SUPABASE_PLAN',
    dnsTimeoutMs: 'PREVIEW_SUPABASE_DNS_TIMEOUT_MS',
    dnsPollMs: 'PREVIEW_SUPABASE_DNS_POLL_MS',
    workspaceMode: 'PREVIEW_SUPABASE_WORKSPACE_MODE',
    branchParentRef: 'PREVIEW_SUPABASE_BRANCH_PARENT_REF',
  };

  const keyToFallbackEnvVar = {
    token: 'SUPABASE_ACCESS_TOKEN',
    orgId: 'SUPABASE_ORG_ID',
    region: 'SUPABASE_REGION',
    dbPass: 'SUPABASE_DB_PASSWORD',
    poolerHost: 'SUPABASE_POOLER_HOST',
    poolerPort: 'SUPABASE_POOLER_PORT',
    plan: 'SUPABASE_PLAN',
    dnsTimeoutMs: 'SUPABASE_DNS_TIMEOUT_MS',
    dnsPollMs: 'SUPABASE_DNS_POLL_MS',
    workspaceMode: 'WORKSPACE_MODE',
    branchParentRef: 'SUPABASE_BRANCH_PARENT_REF',
  };

  const missing = [];
  if (requirePreviewSecrets) {
    for (const key of required) {
      const k = keyToPreviewEnvVar[key] || '';
      if (!k) continue;
      if (!preview[key]) missing.push(k);
    }
  } else {
    for (const key of required) {
      const k = keyToFallbackEnvVar[key] || '';
      if (!k) continue;
      if (!resolved[key]) missing.push(k);
    }
  }

  const usedFallback = Boolean(
    (!preview.token && fallback.token) ||
      (!preview.orgId && fallback.orgId) ||
      (!preview.region && fallback.region) ||
      (!preview.plan && fallback.plan) ||
      (!preview.dbPass && fallback.dbPass) ||
      (!preview.poolerHost && fallback.poolerHost) ||
      (!preview.poolerPort && fallback.poolerPort) ||
      (!preview.dnsTimeoutMs && fallback.dnsTimeoutMs) ||
      (!preview.dnsPollMs && fallback.dnsPollMs) ||
      (!preview.workspaceMode && fallback.workspaceMode) ||
      (!preview.branchParentRef && fallback.branchParentRef),
  );

  return {
    token: resolved.token,
    orgId: resolved.orgId,
    region: resolved.region,
    plan: resolved.plan,
    dbPass: resolved.dbPass,
    poolerHost: resolved.poolerHost,
    poolerPort: resolved.poolerPort,
    dnsTimeoutMs: resolved.dnsTimeoutMs,
    dnsPollMs: resolved.dnsPollMs,
    workspaceMode: resolved.workspaceMode,
    branchParentRef: resolved.branchParentRef,
    missing,
    invalid,
    usedFallback,
  };
}

module.exports = {
  resolvePreviewSupabaseConfig,
};
