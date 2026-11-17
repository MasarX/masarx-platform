#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function normalizeString(value) {
  return String(value || '').trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    report: '',
    profile: '',
    storeOut: '',
    screenshotOut: '',
  };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i += 1) {
    const token = normalizeString(args[i]);
    if (!token) continue;
    if (token === '--report') out.report = normalizeString(args[i + 1]);
    else if (token.startsWith('--report=')) out.report = normalizeString(token.split('=').slice(1).join('='));
    else if (token === '--profile') out.profile = normalizeString(args[i + 1]);
    else if (token.startsWith('--profile=')) out.profile = normalizeString(token.split('=').slice(1).join('='));
    else if (token === '--store-out') out.storeOut = normalizeString(args[i + 1]);
    else if (token.startsWith('--store-out=')) out.storeOut = normalizeString(token.split('=').slice(1).join('='));
    else if (token === '--screenshot-out') out.screenshotOut = normalizeString(args[i + 1]);
    else if (token.startsWith('--screenshot-out=')) out.screenshotOut = normalizeString(token.split('=').slice(1).join('='));
  }
  return out;
}

function sanitizeFailureClass(name, fallback) {
  const normalized = normalizeString(name).toLowerCase();
  if (!normalized) return fallback;
  return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function splitChecks(checks) {
  const rows = Array.isArray(checks) ? checks : [];
  const screenshotChecks = rows.filter((check) => normalizeString(check?.name).startsWith('screenshots.'));
  const storeChecks = rows.filter((check) => !normalizeString(check?.name).startsWith('screenshots.'));
  return { screenshotChecks, storeChecks };
}

function summarizeProofPhase({
  phase,
  profile,
  checks,
  failurePrefix,
}) {
  const normalizedProfile = normalizeString(profile).toLowerCase() || 'release';
  if (normalizedProfile !== 'release') {
    return {
      phase,
      status: 'skipped',
      failure_class: '',
      profile: normalizedProfile,
      skipped_reason: 'release-only-proof-not-required',
      required_checks_total: 0,
      failed_required_checks_total: 0,
      failed_advisory_checks_total: 0,
      failed_check_names: [],
    };
  }

  if (!Array.isArray(checks) || checks.length === 0) {
    return {
      phase,
      status: 'failed',
      failure_class: `${failurePrefix}-missing`,
      profile: normalizedProfile,
      skipped_reason: '',
      required_checks_total: 0,
      failed_required_checks_total: 0,
      failed_advisory_checks_total: 0,
      failed_check_names: [],
    };
  }

  const failedRequired = checks.filter((check) => check?.required !== false && check?.pass === false);
  const failedAdvisory = checks.filter((check) => check?.required === false && check?.pass === false);
  const primaryFailure = failedRequired[0] || null;
  return {
    phase,
    status: failedRequired.length === 0 ? 'passed' : 'failed',
    failure_class: primaryFailure ? sanitizeFailureClass(primaryFailure.name, failurePrefix) : '',
    profile: normalizedProfile,
    skipped_reason: '',
    required_checks_total: checks.filter((check) => check?.required !== false).length,
    failed_required_checks_total: failedRequired.length,
    failed_advisory_checks_total: failedAdvisory.length,
    failed_check_names: failedRequired.map((check) => normalizeString(check?.name)).filter(Boolean),
  };
}

function buildReleaseProofs(report, profileOverride = '') {
  const reportProfile = normalizeString(profileOverride || report?.profile).toLowerCase() || 'release';
  const { screenshotChecks, storeChecks } = splitChecks(report?.checks);
  return {
    storeProof: summarizeProofPhase({
      phase: 'store_metadata_proof',
      profile: reportProfile,
      checks: storeChecks,
      failurePrefix: 'store-metadata-proof',
    }),
    screenshotProof: summarizeProofPhase({
      phase: 'screenshot_freshness_proof',
      profile: reportProfile,
      checks: screenshotChecks,
      failurePrefix: 'screenshot-proof',
    }),
  };
}

function writeJson(targetPath, payload) {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function main() {
  const args = parseArgs();
  const reportPath = normalizeString(args.report);
  if (!reportPath || !fs.existsSync(reportPath)) {
    throw new Error(`Missing FieldOps store preflight report: ${reportPath || '<empty>'}`);
  }
  const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8'));
  const proofs = buildReleaseProofs(report, args.profile);
  if (args.storeOut) writeJson(args.storeOut, proofs.storeProof);
  if (args.screenshotOut) writeJson(args.screenshotOut, proofs.screenshotProof);
  process.stdout.write(`${JSON.stringify(proofs, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mobile-release-proof] ${error?.message || error}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  sanitizeFailureClass,
  splitChecks,
  summarizeProofPhase,
  buildReleaseProofs,
};
