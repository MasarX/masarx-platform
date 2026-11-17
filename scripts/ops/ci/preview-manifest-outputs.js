#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parseFlagArgs } = require('../../utils/cli-args');
const { resolveSurfaceUrl } = require('../preview/shared');
const { buildMaterializedOwnership } = require('../workspace/preview-ownership');

function die(message) {
  console.error(`[preview-manifest-outputs] ${message}`);
  process.exit(1);
}

function normalizeString(value) {
  return String(value || '').trim();
}

function resolveManifestPath(rawPath, cwd = process.cwd()) {
  const manifestPath = normalizeString(rawPath);
  if (!manifestPath) throw new Error('Missing --manifest.');
  return path.isAbsolute(manifestPath) ? manifestPath : path.resolve(cwd, manifestPath);
}

function loadManifest(manifestPath) {
  const resolved = resolveManifestPath(manifestPath);
  if (!fs.existsSync(resolved)) throw new Error(`Manifest not found: ${resolved}`);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function resolveBooleanOutput(value) {
  return value === false || normalizeString(value).toLowerCase() === 'false' ? '0' : '1';
}

function buildPreviewManifestOutputs(manifest) {
  const db = manifest?.surfaces?.db && typeof manifest.surfaces.db === 'object'
    ? manifest.surfaces.db
    : {};
  const ownership = manifest?.workspace_ownership && typeof manifest.workspace_ownership === 'object'
    ? buildMaterializedOwnership(manifest.workspace_ownership)
    : null;
  return {
    materialized_ownership: ownership?.materialized ? '1' : '0',
    project_ref: normalizeString(db.project_ref),
    project_name: normalizeString(db.project_name),
    workspace_mode: normalizeString(db.workspace_mode),
    branch_id: normalizeString(db.branch_id),
    branch_parent_ref: normalizeString(db.branch_parent_ref),
    ownership_generation_token: normalizeString(ownership?.generation_token),
    supabase_url: normalizeString(db.supabase_url),
    env_file: normalizeString(db.env_file || manifest?.env_file),
    runtime_ready: resolveBooleanOutput(db.runtime_ready),
    runtime_ready_at: normalizeString(db.runtime_ready_at),
    jwt_ready: resolveBooleanOutput(db.jwt_ready),
    db_ready: resolveBooleanOutput(db.db_ready),
    rest_ready: resolveBooleanOutput(db.rest_ready),
    readiness_failure_class: normalizeString(db.readiness_failure_class),
    console_url: normalizeString(resolveSurfaceUrl({
      manifest,
      surfaceId: 'console',
      includeEnvFallback: false,
    })),
    portal_url: normalizeString(resolveSurfaceUrl({
      manifest,
      surfaceId: 'portal',
      includeEnvFallback: false,
    })),
    landing_url: normalizeString(resolveSurfaceUrl({
      manifest,
      surfaceId: 'landing',
      includeEnvFallback: false,
    })),
    docs_url: normalizeString(resolveSurfaceUrl({
      manifest,
      surfaceId: 'docs',
      includeEnvFallback: false,
    })),
  };
}

function writeGithubOutput(outputs) {
  const outputPath = normalizeString(process.env.GITHUB_OUTPUT);
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required for --format github-output.');
  const rows = Object.entries(outputs).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${rows.join('\n')}\n`, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const args = parseFlagArgs(argv);
  const format = normalizeString(args.format).toLowerCase();
  const manifest = loadManifest(args.manifest);
  const outputs = buildPreviewManifestOutputs(manifest);
  if (format === 'github-output') {
    writeGithubOutput(outputs);
  } else {
    process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
  }
  return outputs;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  }
}

module.exports = {
  buildPreviewManifestOutputs,
  loadManifest,
  normalizeString,
  resolveBooleanOutput,
  resolveManifestPath,
};
