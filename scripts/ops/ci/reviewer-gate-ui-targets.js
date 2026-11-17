#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const { parseFlagArgs } = require('../../utils/cli-args');

function die(message) {
  console.error(`[reviewer-gate-ui-targets] ${message}`);
  process.exit(1);
}

function normalizeString(value) {
  return String(value || '').trim();
}

function parseCsv(value) {
  return normalizeString(value)
    .split(',')
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
}

function resolveReviewerGateUiTargets({
  surfaceIds = '',
  consoleUrl = '',
  portalUrl = '',
} = {}) {
  const surfaces = parseCsv(surfaceIds);
  const projects = [];
  const missing = [];

  if (surfaces.includes('console')) {
    projects.push('console');
    if (!normalizeString(consoleUrl)) missing.push('console');
  }
  if (surfaces.includes('portal')) {
    projects.push('portal');
    if (!normalizeString(portalUrl)) missing.push('portal');
  }

  return {
    e2eProjects: projects,
    missingSurfaces: missing,
    missingUrls: missing.length > 0,
  };
}

function formatOutputs(result) {
  return {
    e2e_projects: Array.isArray(result.e2eProjects) ? result.e2eProjects.join(',') : '',
    missing_surfaces: Array.isArray(result.missingSurfaces) ? result.missingSurfaces.join(',') : '',
    missing_urls: result.missingUrls ? '1' : '0',
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
  const result = resolveReviewerGateUiTargets({
    surfaceIds: args['surface-ids'] || process.env.SURFACE_IDS,
    consoleUrl: args['console-url'] || process.env.CONSOLE_URL,
    portalUrl: args['portal-url'] || process.env.PORTAL_URL,
  });
  const outputs = formatOutputs(result);
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
  formatOutputs,
  normalizeString,
  parseCsv,
  resolveReviewerGateUiTargets,
};
