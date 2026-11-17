const crypto = require('crypto');

function authSurfaceIdentitySha256(identity = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    surface: String(identity.surface || '').trim(),
    email: String(identity.email || '').trim().toLowerCase(),
    user_type: String(identity.user_type || '').trim().toLowerCase(),
    auth_user_id: String(identity.auth_user_id || '').trim(),
    organization_id: String(identity.organization_id || '').trim(),
  })).digest('hex');
}

function userMatchesAnyType(user, types = []) {
  const userType = String(user?.user_type || '').trim().toLowerCase();
  return types.some((type) => userType === String(type || '').trim().toLowerCase());
}

function pickUser(users = [], preferredTypes = []) {
  return users.find((user) => userMatchesAnyType(user, preferredTypes) && user?.email)
    || users.find((user) => user?.email);
}

function pickTypedUser(users = [], preferredTypes = []) {
  return users.find((user) => userMatchesAnyType(user, preferredTypes) && user?.email);
}

function resolveSurfaceIdentities(manifest = {}) {
  const users = Array.isArray(manifest.users) ? manifest.users : [];
  const operator = pickUser(users, ['ops_admin', 'super_admin', 'tenant_admin']);
  const portal = pickUser(users, ['ops_admin', 'super_admin', 'tenant_admin', 'client_admin']);
  const driver = pickTypedUser(users, ['driver']);
  const surfaces = [
    {
      surface: 'console-v2',
      required: true,
      user: operator,
      expected_types: ['ops_admin', 'super_admin', 'tenant_admin'],
    },
    {
      surface: 'portal',
      required: true,
      user: portal,
      expected_types: ['ops_admin', 'super_admin', 'tenant_admin', 'client_admin'],
    },
    {
      surface: 'fieldops-metro',
      required: true,
      user: driver,
      expected_types: ['driver'],
      proof_label: 'mobile_v2_development_runtime_proof',
    },
  ];
  return surfaces.map((entry) => ({
    ...entry,
    email: String(entry.user?.email || '').trim().toLowerCase(),
    user_type: String(entry.user?.user_type || '').trim(),
    auth_user_id: String(entry.user?.auth_user_id || '').trim(),
    scope_type: String(entry.user?.scope_type || '').trim(),
    organization_id: String(manifest.organization?.id || '').trim(),
    run_id: String(manifest.run_id || '').trim(),
    identity_present: Boolean(entry.user?.email),
  }));
}


function loadAuthManifestAuthority(filePath, workspaceId, services, options = {}) {
  const bytes = (options.readFileSyncImpl || require('fs').readFileSync)(filePath);
  const manifest = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
  if (manifest.mode !== 'ephemeral' || !workspaceId || manifest.run_id !== workspaceId) {
    throw new Error('auth manifest is not bound to the exact ephemeral workspace');
  }
  return {
    manifest_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    identities: resolveSurfaceIdentities(manifest).filter((entry) => services.includes(entry.surface)),
  };
}

function authProofBindingFailures(proof, authority, services) {
  const failures = [];
  const expected = authority?.identities || [];
  if (!authority || !/^[0-9a-f]{64}$/.test(String(proof?.manifest_sha256 || ''))
    || proof.manifest_sha256 !== authority.manifest_sha256) failures.push('auth_manifest_identity_mismatch');
  for (const identity of expected) {
    const matches = (proof?.surfaces || []).filter((entry) => entry.surface === identity.surface);
    if (!identity.auth_user_id || !identity.organization_id || !identity.email
      || !identity.expected_types.includes(identity.user_type)
      || matches.length !== 1 || matches[0].identity_sha256 !== authSurfaceIdentitySha256(identity)) {
      failures.push('auth_surface_identity_mismatch:' + identity.surface);
    }
  }
  const protectedServices = services.filter((service) =>
    require('../runtime-service-selection').PROTECTED_PROOF_SERVICES.has(service));
  if (expected.length !== protectedServices.length) failures.push('auth_required_identity_missing');
  return failures;
}


function authProofSummaryBindingFailures(actual, expected, services) {
  const failures = [];
  const required = services.filter((service) =>
    require('../runtime-service-selection').PROTECTED_PROOF_SERVICES.has(service));
  if (!/^[0-9a-f]{64}$/.test(String(expected?.manifest_sha256 || ''))
    || actual?.manifest_sha256 !== expected.manifest_sha256) failures.push('auth_manifest_identity_mismatch');
  for (const surface of required) {
    const expectedMatches = (expected?.surfaces || []).filter((entry) => entry.surface === surface);
    const actualMatches = (actual?.surfaces || []).filter((entry) => entry.surface === surface);
    if (expectedMatches.length !== 1 || actualMatches.length !== 1
      || !/^[0-9a-f]{64}$/.test(String(expectedMatches[0]?.identity_sha256 || ''))
      || actualMatches[0]?.identity_sha256 !== expectedMatches[0]?.identity_sha256) {
      failures.push('auth_surface_identity_mismatch:' + surface);
    }
  }
  if (actual?.surfaces?.length !== required.length || expected?.surfaces?.length !== required.length) {
    failures.push('auth_surface_selection_mismatch');
  }
  return failures;
}

module.exports = { authProofSummaryBindingFailures, authSurfaceIdentitySha256, resolveSurfaceIdentities, loadAuthManifestAuthority, authProofBindingFailures };
