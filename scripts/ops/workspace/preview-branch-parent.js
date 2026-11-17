function uniqueNonEmpty(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const trimmed = String(value || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function readEnv(key, env = process.env) {
  return String((env && env[key]) || '').trim();
}

function resolveBranchParentCandidates({ env = process.env, resolvedConfig = null, extra = [] } = {}) {
  const cfgBranchParentRef =
    resolvedConfig && typeof resolvedConfig === 'object'
      ? String(resolvedConfig.branchParentRef || '').trim()
      : '';

  return uniqueNonEmpty([
    readEnv('PREVIEW_SUPABASE_BRANCH_PARENT_REF', env),
    readEnv('SUPABASE_BRANCH_PARENT_REF', env),
    readEnv('SUPABASE_PROJECT_ID', env),
    readEnv('SUPABASE_PARENT_PROJECT_REF', env),
    readEnv('PREVIEW_PROJECT_REF', env),
    readEnv('PREVIEW_SUPABASE_PROJECT_ID', env),
    cfgBranchParentRef,
    ...(Array.isArray(extra) ? extra : [extra]),
  ]);
}

function isRemovedBranchParentError(err) {
  const status = Number(err?.status || 0);
  const details = String(err?.body?.message || err?.body?.error || '').toLowerCase();
  const message = `${String(err?.message || '').toLowerCase()} ${details}`;
  return status === 400 && message.includes('resource has been removed');
}

function shouldTryAlternateBranchParent(err) {
  if (String(err?.code || '') === 'branch_create_outcome_ambiguous') return false;
  const status = Number(err?.status || 0);
  return status === 403 || status === 404 || isRemovedBranchParentError(err);
}

function shouldFallbackToProjectMode(err) {
  if (String(err?.code || '') === 'branch_create_outcome_ambiguous') return false;
  const status = Number(err?.status || 0);
  const details = String(err?.body?.message || err?.body?.error || '').toLowerCase();
  const message = `${String(err?.message || '').toLowerCase()} ${details}`;
  if (status === 401) {
    return (
      message.includes('jwt could not be decoded') ||
      message.includes('invalid jwt') ||
      (message.includes('jwt') && message.includes('decode'))
    );
  }
  if ([403, 404, 422, 429].includes(status)) return true;
  if (status >= 500) return true;
  if (status === 0 && (message.includes('fetch failed') || message.includes('network'))) return true;
  if (status === 409 && message.includes('preview branch')) return true;
  if (isRemovedBranchParentError(err)) return true;
  if (status !== 400) return false;
  return (
    message.includes('preview branching') ||
    message.includes('branching is not enabled') ||
    message.includes('not authorized to enable')
  );
}

async function withBranchParentFallback({
  parentRefs,
  action,
  actionLabel = 'branch action',
  warn = console.warn,
} = {}) {
  const refs = uniqueNonEmpty(parentRefs);
  if (!refs.length) {
    throw new Error(
      'Missing branch parent project ref. Set PREVIEW_SUPABASE_BRANCH_PARENT_REF (or SUPABASE_BRANCH_PARENT_REF / SUPABASE_PROJECT_ID / SUPABASE_PARENT_PROJECT_REF).',
    );
  }
  if (typeof action !== 'function') {
    throw new Error('withBranchParentFallback requires an action(parentProjectRef) function.');
  }

  let lastErr = null;
  for (let index = 0; index < refs.length; index += 1) {
    const parentProjectRef = refs[index];
    try {
      const value = await action(parentProjectRef, index);
      return { parentProjectRef, value };
    } catch (err) {
      lastErr = err;
      const hasNext = index < refs.length - 1;
      if (hasNext && shouldTryAlternateBranchParent(err)) {
        const message = String(err?.message || 'unknown error');
        warn(
          `[preview-branch-parent] ${actionLabel} failed for parent_ref=${parentProjectRef}; trying next candidate (${message})`,
        );
        continue;
      }
      throw err;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error(`[preview-branch-parent] ${actionLabel} failed before attempting any parent refs.`);
}

module.exports = {
  uniqueNonEmpty,
  resolveBranchParentCandidates,
  isRemovedBranchParentError,
  shouldTryAlternateBranchParent,
  shouldFallbackToProjectMode,
  withBranchParentFallback,
};
