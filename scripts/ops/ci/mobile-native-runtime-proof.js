#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const SHA_RE = /^[0-9a-f]{40}$/;
const AVD_RE = /^MasarX_FieldOps_API34[A-Za-z0-9_.-]*$/;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeSha(value, label = 'candidate SHA') {
  const sha = normalizeString(value).toLowerCase();
  if (!SHA_RE.test(sha)) {
    throw new Error(`${label} must be a full 40-character commit SHA.`);
  }
  return sha;
}

function parsePositiveInteger(value, label) {
  const text = normalizeString(value);
  const parsed = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function readJson(filePath, label) {
  const resolved = path.resolve(normalizeString(filePath));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} is missing: ${resolved || '<empty>'}.`);
  }
  try {
    return { resolved, payload: JSON.parse(fs.readFileSync(resolved, 'utf8')) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertInsideDirectory(parentDir, filePath, label) {
  const parent = path.resolve(parentDir);
  const candidate = path.resolve(filePath);
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`${label} escapes the native proof directory.`);
  }
  return candidate;
}

function validateNativeManifest(manifestPath, expectedSerial = '') {
  const { resolved, payload } = readJson(manifestPath, 'Native runtime manifest');
  const manifestDir = path.dirname(resolved);
  if (normalizeString(payload.capture_mode) !== 'native_runtime') {
    throw new Error('Native runtime manifest capture_mode must be native_runtime.');
  }
  const platforms = Array.isArray(payload.platforms)
    ? payload.platforms.map((value) => normalizeString(value).toLowerCase()).filter(Boolean)
    : [];
  if (platforms.length !== 1 || platforms[0] !== 'android') {
    throw new Error('Native runtime manifest must contain exactly the Android platform.');
  }
  const serial = normalizeString(payload?.devices?.android?.serial);
  if (!serial || (expectedSerial && serial !== normalizeString(expectedSerial))) {
    throw new Error('Native runtime manifest Android serial does not match the owned emulator.');
  }
  const selftest = (Array.isArray(payload.selftests) ? payload.selftests : []).find(
    (entry) => normalizeString(entry?.platform).toLowerCase() === 'android',
  );
  if (!selftest || normalizeString(selftest.status).toLowerCase() !== 'pass') {
    throw new Error('Native runtime manifest Android self-test must pass.');
  }
  const scenarios = Array.isArray(payload.scenarios) ? payload.scenarios : [];
  if (scenarios.length === 0) {
    throw new Error('Native runtime manifest must contain Android screenshot scenarios.');
  }
  const files = scenarios.map((scenario, index) => {
    if (
      normalizeString(scenario?.platform).toLowerCase() !== 'android'
      || normalizeString(scenario?.capture_source).toLowerCase() !== 'adb'
    ) {
      throw new Error(`Native runtime scenario ${index + 1} is not Android ADB evidence.`);
    }
    const fileName = normalizeString(scenario?.file);
    if (!fileName || path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith('.png')) {
      throw new Error(`Native runtime scenario ${index + 1} has an unsafe screenshot file name.`);
    }
    const filePath = assertInsideDirectory(manifestDir, path.join(manifestDir, fileName), 'Screenshot file');
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Native runtime screenshot is missing: ${fileName}.`);
    }
    return {
      name: normalizeString(scenario?.name),
      file: fileName,
      sha256: sha256File(filePath),
      bytes: fs.statSync(filePath).size,
    };
  });
  return {
    resolved,
    payload,
    serial,
    files,
    manifest_sha256: sha256File(resolved),
  };
}

function validateAppRuntime(reportPath, expectedSerial = '') {
  const { resolved, payload } = readJson(reportPath, 'Native app runtime report');
  const packageName = normalizeString(payload.package_name);
  const serial = normalizeString(payload.android_serial);
  const screenshotName = normalizeString(payload.screenshot);
  if (
    payload.status !== 'passed'
    || !/^com\.masarx\.fieldops(?:\.[a-z0-9_.]+)?$/.test(packageName)
    || !serial
    || (expectedSerial && serial !== normalizeString(expectedSerial))
    || !Number.isSafeInteger(payload.pid)
    || payload.pid <= 0
    || !normalizeString(payload.resumed_activity).includes(packageName)
    || normalizeString(payload.ui_ready_marker) !== 'Sign in to continue'
    || payload.configuration_error_absent !== true
    || !/^[0-9a-f]{64}$/.test(normalizeString(payload.apk_sha256))
    || path.basename(screenshotName) !== screenshotName
    || !screenshotName.toLowerCase().endsWith('.png')
  ) {
    throw new Error('Native app runtime report does not prove the installed FieldOps app.');
  }
  const screenshotPath = assertInsideDirectory(
    path.dirname(resolved),
    path.join(path.dirname(resolved), screenshotName),
    'Native app screenshot',
  );
  if (!fs.existsSync(screenshotPath) || !fs.statSync(screenshotPath).isFile()) {
    throw new Error('Native app runtime screenshot is missing.');
  }
  return {
    package_name: packageName,
    android_serial: serial,
    apk_sha256: normalizeString(payload.apk_sha256),
    report_sha256: sha256File(resolved),
    screenshot_sha256: sha256File(screenshotPath),
  };
}

function buildNativeRuntimeProof({
  manifestPath,
  appRuntimePath,
  candidateSha,
  avdName,
  serial,
  workflowRunId,
  workflowRunAttempt,
  now = new Date(),
}) {
  const exactSha = normalizeSha(candidateSha);
  const exactAvd = normalizeString(avdName);
  if (!AVD_RE.test(exactAvd)) {
    throw new Error('AVD name must use the canonical MasarX FieldOps API 34 namespace.');
  }
  const manifest = validateNativeManifest(manifestPath, serial);
  const appRuntime = validateAppRuntime(appRuntimePath, serial);
  return {
    schema_version: SCHEMA_VERSION,
    phase: 'mobile_native_runtime_candidate',
    status: 'passed',
    candidate_sha: exactSha,
    avd_name: exactAvd,
    android_serial: manifest.serial,
    workflow_run_id: parsePositiveInteger(workflowRunId, 'workflow run id'),
    workflow_run_attempt: parsePositiveInteger(workflowRunAttempt, 'workflow run attempt'),
    captured_at: normalizeString(manifest.payload.captured_at),
    verified_at: now.toISOString(),
    manifest_sha256: manifest.manifest_sha256,
    scenario_count: manifest.files.length,
    screenshots: manifest.files,
    app_runtime: appRuntime,
  };
}

function verifyNativeRuntimeProof({
  proofPath,
  manifestPath,
  appRuntimePath,
  expectedCandidateSha,
  expectedAvdName,
  expectedWorkflowRunId,
  expectedWorkflowRunAttempt,
}) {
  const proof = readJson(proofPath, 'Mobile native runtime proof').payload;
  if (proof.schema_version !== SCHEMA_VERSION) throw new Error('Unsupported mobile native runtime proof schema.');
  if (proof.phase !== 'mobile_native_runtime_candidate' || proof.status !== 'passed') {
    throw new Error('Mobile native runtime proof is not a passing candidate proof.');
  }
  const expectedSha = normalizeSha(expectedCandidateSha, 'expected candidate SHA');
  if (normalizeSha(proof.candidate_sha, 'proof candidate SHA') !== expectedSha) {
    throw new Error('Mobile native runtime proof candidate SHA mismatch.');
  }
  const expectedAvd = normalizeString(expectedAvdName);
  if (!AVD_RE.test(expectedAvd) || normalizeString(proof.avd_name) !== expectedAvd) {
    throw new Error('Mobile native runtime proof AVD identity mismatch.');
  }
  if (
    parsePositiveInteger(proof.workflow_run_id, 'proof workflow run id')
      !== parsePositiveInteger(expectedWorkflowRunId, 'expected workflow run id')
    || parsePositiveInteger(proof.workflow_run_attempt, 'proof workflow run attempt')
      !== parsePositiveInteger(expectedWorkflowRunAttempt, 'expected workflow run attempt')
  ) {
    throw new Error('Mobile native runtime proof workflow identity mismatch.');
  }
  const manifest = validateNativeManifest(manifestPath, proof.android_serial);
  const appRuntime = validateAppRuntime(appRuntimePath, proof.android_serial);
  if (proof.manifest_sha256 !== manifest.manifest_sha256) {
    throw new Error('Mobile native runtime proof manifest digest mismatch.');
  }
  if (proof.scenario_count !== manifest.files.length) {
    throw new Error('Mobile native runtime proof scenario count mismatch.');
  }
  if (JSON.stringify(proof.screenshots) !== JSON.stringify(manifest.files)) {
    throw new Error('Mobile native runtime proof screenshot digest set mismatch.');
  }
  if (JSON.stringify(proof.app_runtime) !== JSON.stringify(appRuntime)) {
    throw new Error('Mobile native runtime proof app evidence mismatch.');
  }
  return proof;
}

function parseArgs(argv = process.argv.slice(2)) {
  const [command, ...tokens] = argv;
  const options = { command: normalizeString(command) };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = normalizeString(tokens[index]);
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    options[key] = normalizeString(tokens[index + 1]);
    index += 1;
  }
  return options;
}

function writeJson(targetPath, payload) {
  const resolved = path.resolve(normalizeString(targetPath));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function main() {
  const options = parseArgs();
  if (options.command === 'create') {
    const proof = buildNativeRuntimeProof({
      manifestPath: options.manifest,
      appRuntimePath: options['app-runtime'],
      candidateSha: options['candidate-sha'],
      avdName: options['avd-name'],
      serial: options.serial,
      workflowRunId: options['workflow-run-id'],
      workflowRunAttempt: options['workflow-run-attempt'],
    });
    if (!options.out) throw new Error('create requires --out.');
    writeJson(options.out, proof);
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    return;
  }
  if (options.command === 'verify') {
    const proof = verifyNativeRuntimeProof({
      proofPath: options.proof,
      manifestPath: options.manifest,
      appRuntimePath: options['app-runtime'],
      expectedCandidateSha: options['expected-candidate-sha'],
      expectedAvdName: options['expected-avd-name'],
      expectedWorkflowRunId: options['expected-workflow-run-id'],
      expectedWorkflowRunAttempt: options['expected-workflow-run-attempt'],
    });
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    return;
  }
  throw new Error('Usage: mobile-native-runtime-proof.js <create|verify> [options].');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mobile-native-runtime-proof] ${error?.message || error}`);
    process.exit(1);
  }
}

module.exports = {
  buildNativeRuntimeProof,
  normalizeSha,
  validateAppRuntime,
  validateNativeManifest,
  verifyNativeRuntimeProof,
};
