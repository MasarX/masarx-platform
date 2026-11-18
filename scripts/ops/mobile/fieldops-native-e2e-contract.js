/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const NATIVE_PROOF_RESOURCE = 'fieldops-mobile-v2-proof';
const SERIAL_SCOPED_RESOURCES = new Set([
  'android-emulator',
  'adb-reverse',
  NATIVE_PROOF_RESOURCE,
]);
const REQUIRED_EVIDENCE = [
  'policy_evidence',
  'backend_evidence',
  'native_evidence',
  'device_evidence',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveFieldOpsNativeE2eContract(repoRoot) {
  const root = path.resolve(repoRoot);
  const easConfig = readJson(path.join(root, 'apps', 'fieldops', 'eas.json'));
  const leasePolicy = readJson(path.join(root, 'config', 'ops', 'runtime-lease-policy.json'));
  const proofResource = leasePolicy.resource_classes?.[NATIVE_PROOF_RESOURCE];
  if (!proofResource || !Array.isArray(proofResource.requires)) {
    throw new Error(`[fieldops-native-e2e] Missing ${NATIVE_PROOF_RESOURCE} runtime policy.`);
  }

  const androidProfiles = Object.entries(easConfig.build || {})
    .filter(([, profile]) => profile?.android?.buildType === 'apk')
    .map(([name]) => name)
    .sort();

  return {
    schema_version: 1,
    android_build_profiles: androidProfiles,
    required_runtime_resources: Array.from(
      new Set([...proofResource.requires, NATIVE_PROOF_RESOURCE])
    ).sort(),
    required_evidence: [...REQUIRED_EVIDENCE],
  };
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateFieldOpsNativeE2eAdmission(input, contract) {
  const errors = [];
  const owner = normalizeText(input?.owner_thread_id);
  const serial = normalizeText(input?.emulator_serial);
  const profile = normalizeText(input?.build_profile);
  const leases = Array.isArray(input?.leases) ? input.leases : [];
  const evidence = input?.evidence && typeof input.evidence === 'object' ? input.evidence : {};

  if (!owner) errors.push('owner_thread_id_required');
  if (!contract.android_build_profiles.includes(profile)) {
    errors.push(`unsupported_android_build_profile:${profile || 'missing'}`);
  }
  if (!/^emulator-\d+$/i.test(serial)) {
    errors.push(`invalid_emulator_serial:${serial || 'missing'}`);
  }

  for (const resource of contract.required_runtime_resources) {
    const candidates = leases.filter(
      (lease) => normalizeText(lease?.resource_class) === resource
    );
    if (candidates.length !== 1) {
      errors.push(`runtime_lease_count:${resource}:${candidates.length}`);
      continue;
    }
    const lease = candidates[0];
    if (normalizeText(lease.owner_thread_id) !== owner) {
      errors.push(`runtime_owner_mismatch:${resource}`);
    }
    if (
      SERIAL_SCOPED_RESOURCES.has(resource) &&
      normalizeText(lease.serial) !== serial
    ) {
      errors.push(`runtime_serial_mismatch:${resource}`);
    }
  }

  for (const key of contract.required_evidence) {
    if (!normalizeText(evidence[key])) errors.push(`evidence_required:${key}`);
  }
  for (const key of [
    'mobile_v2_policy_enabled',
    'backend_readback',
    'native_mobile_v2_visible',
    'device_readback',
  ]) {
    if (input?.proof_gates?.[key] !== true) errors.push(`proof_gate_required:${key}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    owner_thread_id: owner,
    emulator_serial: serial,
    build_profile: profile,
  };
}

module.exports = {
  NATIVE_PROOF_RESOURCE,
  resolveFieldOpsNativeE2eContract,
  validateFieldOpsNativeE2eAdmission,
};
