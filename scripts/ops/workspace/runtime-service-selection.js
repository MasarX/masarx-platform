function splitSelection(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitSelection(entry));
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function ownSelection(source = {}, keys = []) {
  const providedKeys = keys.filter((key) => (
    Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined
  ));
  if (providedKeys.length > 1) {
    const parserAliasesEquivalent = providedKeys.every((key) => (
      key.replace(/-/g, '_') === providedKeys[0].replace(/-/g, '_') &&
      JSON.stringify(source[key]) === JSON.stringify(source[providedKeys[0]])
    ));
    if (!parserAliasesEquivalent) {
      throw new Error(`Conflicting runtime selection aliases: ${providedKeys.join(',')}`);
    }
  }
  if (providedKeys.length >= 1) {
    const [key] = providedKeys;
    return { provided: true, key, value: source[key] };
  }
  return { provided: false, key: '', value: undefined };
}

function assertNoDuplicateSelection(entries, label) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) throw new Error(`Duplicate ${label}: ${entry}`);
    seen.add(entry);
  }
}

function resolvePolicyServiceSelection(policy = {}, selection = {}) {
  const allowed = Object.keys(policy.services || {}).sort();
  if (!selection.provided) {
    if (policy.dependency_readiness?.omitted_service_selection !== 'all_declared') {
      throw new Error('Runtime policy omitted service selection is not declared');
    }
    return allowed;
  }
  const requested = splitSelection(selection.value);
  assertNoDuplicateSelection(requested, 'runtime service');
  const unknown = requested.filter((serviceName) => !allowed.includes(serviceName));
  if (unknown.length) throw new Error(`Unknown runtime service: ${unknown.join(',')}`);
  return requested.sort();
}

const WEB_TARGET_ALIASES = Object.freeze({
  console: Object.freeze(['console', 'console-v2']),
  landing: Object.freeze(['landing', 'landing-page']),
  portal: Object.freeze(['portal', 'portal-server']),
});
const ALL_WEB_ALIASES = new Set(['all', 'web']);
const EMPTY_WEB_ALIASES = new Set(['none', 'backend-only', 'backend']);

function serviceForWebTarget(policy = {}, target = '') {
  const matches = Object.entries(policy.services || {})
    .filter(([, config]) => String(config?.profile || '').trim().toLowerCase() === target)
    .map(([serviceName]) => serviceName);
  if (matches.length !== 1) throw new Error(`Runtime web target ${target} must map to exactly one declared service`);
  return matches[0];
}

function resolveWebTargetSelection(policy = {}, selection = {}, options = {}) {
  const raw = selection.provided
    ? selection.value
    : (options.defaultValue === undefined ? 'console' : options.defaultValue);
  if (Array.isArray(raw) && raw.length > 1) throw new Error(`Duplicate web selector: ${selection.key || 'web'}`);
  const entries = splitSelection(raw);
  assertNoDuplicateSelection(entries, 'web target');
  if (!entries.length) return [];
  if (entries.some((entry) => EMPTY_WEB_ALIASES.has(entry))) {
    if (entries.length !== 1) throw new Error('Backend-only web selector cannot be combined with web targets');
    return [];
  }
  if (entries.some((entry) => ALL_WEB_ALIASES.has(entry))) {
    if (entries.length !== 1) throw new Error('All-web selector cannot be combined with web targets');
    return Object.keys(WEB_TARGET_ALIASES);
  }
  const aliasToTarget = new Map();
  for (const [target, aliases] of Object.entries(WEB_TARGET_ALIASES)) {
    for (const alias of aliases) aliasToTarget.set(alias, target);
  }
  const resolved = entries.map((entry) => {
    const target = aliasToTarget.get(entry);
    if (!target) throw new Error(`Unknown runtime web target: ${entry}`);
    serviceForWebTarget(policy, target);
    return target;
  });
  assertNoDuplicateSelection(resolved, 'canonical web target');
  return resolved;
}


const FRONTEND_PROOF_SERVICES = new Set(['console-v2', 'landing', 'portal', 'fieldops-metro']);
const PROTECTED_PROOF_SERVICES = new Set(['console-v2', 'portal', 'fieldops-metro']);

function resolveProofServiceSelection(policy, options = {}, env = {}) {
  const explicit = ownSelection(options, ['services', 'service']);
  const selection = explicit.provided ? explicit : ownSelection(env, ['DOCKER_RUNTIME_DEPENDENCY_SERVICES']);
  if (selection.provided && typeof selection.value !== 'string'
    && !(Array.isArray(selection.value) && selection.value.every((entry) => typeof entry === 'string'))) {
    throw new Error('Runtime proof service selection must be a string or flat string array');
  }
  return resolvePolicyServiceSelection(policy, selection);
}

function runtimeProofApplicability(services = []) {
  const selected = new Set(services);
  const frontend = services.some((service) => FRONTEND_PROOF_SERVICES.has(service));
  const auth = services.some((service) => PROTECTED_PROOF_SERVICES.has(service));
  return {
    all_surface_http_probes_reachable: frontend,
    all_surfaces_runtime_proven: frontend,
    browser_proof_present: frontend,
    browser_proof_or_startup_boundary_proven: frontend,
    backend_readback_proof_present: true,
    backend_readback_proof_passed: true,
    landing_intake_readback_proven: selected.has('landing'),
    auth_fixture_proof_present: auth,
    auth_fixture_proof_passed: auth,
    auth_fixture_identity_bound: auth,
    backend_reachable: true,
    edge_functions_reachable: selected.has('edge-functions'),
    fieldops_service_canonical: selected.has('fieldops-metro'),
    mobile_v2_development_runtime_proof: selected.has('fieldops-metro'),
    native_release_gate_not_satisfied: true,
    seed_disabled: true,
  };
}

function proofServiceSelectionMatches(actual, expected) {
  return Array.isArray(actual) && actual.every((entry) => typeof entry === 'string')
    && new Set(actual).size === actual.length
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

module.exports = {
  FRONTEND_PROOF_SERVICES,
  PROTECTED_PROOF_SERVICES,
  resolveProofServiceSelection,
  runtimeProofApplicability,
  proofServiceSelectionMatches,
  ownSelection,
  resolvePolicyServiceSelection,
  resolveWebTargetSelection,
  serviceForWebTarget,
  splitSelection,
};
