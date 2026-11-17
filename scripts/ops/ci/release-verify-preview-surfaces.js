#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const { parseFlagArgs } = require('../../utils/cli-args');

const UI_SURFACE_IDS = new Set(['console', 'portal', 'ui']);

function die(message) {
  console.error(`[release-verify-preview-surfaces] ${message}`);
  process.exit(1);
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
}

function addUnique(list, seen, surfaceId) {
  const normalized = String(surfaceId || '').trim().toLowerCase();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  list.push(normalized);
}

function resolveReleaseVerifyPreviewSurfaces(input = {}) {
  const requiredPreviewSurfaceIds = parseCsv(input.requiredPreviewSurfaceIds);
  const uiProjects = parseCsv(input.uiProjects).filter((surfaceId) => surfaceId !== 'ui');
  const runUiGateEffective = isTruthy(input.runUiGateEffective);

  const surfaceIds = [];
  const seen = new Set();

  // Preview-backed validation always needs the runtime preview topology.
  addUnique(surfaceIds, seen, 'db');

  for (const surfaceId of requiredPreviewSurfaceIds) {
    if (
      surfaceId === 'db'
    ) {
      continue;
    }
    if (UI_SURFACE_IDS.has(surfaceId) && !runUiGateEffective) {
      continue;
    }
    addUnique(surfaceIds, seen, surfaceId);
  }

  if (runUiGateEffective) {
    for (const surfaceId of uiProjects) {
      addUnique(surfaceIds, seen, surfaceId);
    }
  }

  return {
    csv: surfaceIds.join(','),
    surface_ids: surfaceIds,
  };
}

function writeGithubOutput(outputs) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) die('GITHUB_OUTPUT not set; use --format json for local runs.');
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function parseArgs(argv = process.argv.slice(2)) {
  const flags = parseFlagArgs(argv);
  return {
    format: String(flags.format || '').trim().toLowerCase(),
  };
}

function main(argv = process.argv.slice(2)) {
  const { format } = parseArgs(argv);
  const outputs = resolveReleaseVerifyPreviewSurfaces({
    requiredPreviewSurfaceIds: process.env.REQUIRED_PREVIEW_SURFACE_IDS,
    uiProjects: process.env.UI_PROJECTS,
    runUiGateEffective: process.env.RUN_UI_GATE_EFFECTIVE,
  });

  if (format === 'github-output') {
    writeGithubOutput({
      csv: outputs.csv,
    });
  } else {
    process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
  }

  console.log(
    `[release-verify-preview-surfaces] effective_preview_surface_ids=${outputs.csv || '<none>'}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  UI_SURFACE_IDS,
  addUnique,
  isTruthy,
  parseCsv,
  resolveReleaseVerifyPreviewSurfaces,
};
