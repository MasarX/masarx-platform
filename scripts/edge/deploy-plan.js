function normalizeChangedPath(p) {
  return String(p || '').trim().replace(/\\/g, '/');
}

function isSharedEdgeChange(p) {
  const filePath = normalizeChangedPath(p);
  if (!filePath) return false;
  if (filePath.startsWith('supabase/functions/_shared/')) return true;
  if (filePath.startsWith('config/edge/')) return true;
  return false;
}

function extractEdgeFunctionNameFromPath(p) {
  const filePath = normalizeChangedPath(p);
  if (!filePath.startsWith('supabase/functions/')) return '';
  const rest = filePath.slice('supabase/functions/'.length);
  const first = rest.split('/')[0] || '';
  if (!first || first === '_shared') return '';
  return first;
}

function planIncrementalEdgeDeploy({ changedFiles, withJwt, noVerifyJwt }) {
  const files = Array.isArray(changedFiles)
    ? changedFiles.map(normalizeChangedPath).filter(Boolean)
    : [];
  const jwt = Array.isArray(withJwt) ? withJwt : [];
  const noVerify = Array.isArray(noVerifyJwt) ? noVerifyJwt : [];

  if (files.length === 0) {
    return {
      mode: 'none',
      reason: 'no_edge_changes',
      withJwt: [],
      noVerifyJwt: [],
      changedFunctions: [],
    };
  }

  if (files.some(isSharedEdgeChange)) {
    return {
      mode: 'all',
      reason: 'shared_or_registry_change',
      withJwt: jwt,
      noVerifyJwt: noVerify,
      changedFunctions: [],
    };
  }

  const changed = new Set();
  for (const file of files) {
    const name = extractEdgeFunctionNameFromPath(file);
    if (name) changed.add(name);
  }

  const selectedWithJwt = jwt.filter((fn) => fn && changed.has(fn.name));
  const selectedNoVerifyJwt = noVerify.filter((fn) => fn && changed.has(fn.name));

  if (selectedWithJwt.length + selectedNoVerifyJwt.length === 0) {
    return {
      mode: 'none',
      reason: 'no_enabled_functions_changed',
      withJwt: [],
      noVerifyJwt: [],
      changedFunctions: Array.from(changed).sort(),
    };
  }

  return {
    mode: 'subset',
    reason: 'function_changes',
    withJwt: selectedWithJwt,
    noVerifyJwt: selectedNoVerifyJwt,
    changedFunctions: Array.from(changed).sort(),
  };
}

module.exports = {
  normalizeChangedPath,
  isSharedEdgeChange,
  extractEdgeFunctionNameFromPath,
  planIncrementalEdgeDeploy,
};

