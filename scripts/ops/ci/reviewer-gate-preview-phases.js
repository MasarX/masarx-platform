#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const {
  loadDeploySurfaceRegistry,
  compileRegistry,
  resolvePreviewProvisionSurfaces,
} = require('./deploy-surface-registry');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    format: '',
    surfaceIds: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--format') out.format = String(argv[++i] || '').trim();
    else if (arg.startsWith('--format=')) out.format = arg.split('=').slice(1).join('=').trim();
    else if (arg === '--surface-ids') out.surfaceIds = String(argv[++i] || '').trim();
    else if (arg.startsWith('--surface-ids=')) out.surfaceIds = arg.split('=').slice(1).join('=').trim();
  }
  return out;
}

function splitCsv(raw) {
  return Array.from(new Set(
    String(raw || '')
      .split(',')
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  )).sort();
}

function writeGithubOutput(outputs) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required for --format github-output.');
  const rows = Object.entries(outputs).map(([key, value]) => `${key}=${String(value == null ? '' : value)}`);
  fs.appendFileSync(outputPath, `${rows.join('\n')}\n`, 'utf8');
}

function resolveOutputs(surfaceIds) {
  const { registry } = loadDeploySurfaceRegistry({});
  const compiled = compileRegistry(registry);
  const phases = resolvePreviewProvisionSurfaces({
    compiled,
    surfaceIds,
  });
  return {
    runtime_preview_surface_ids: phases.runtimeSurfaceIds.join(','),
    hosted_preview_surface_ids: phases.hostedSurfaceIds.join(','),
    needs_hosted_preview_provision: phases.needsHostedProvision ? '1' : '0',
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outputs = resolveOutputs(splitCsv(args.surfaceIds));
  if (String(args.format || '').trim().toLowerCase() === 'github-output') {
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
    console.error(`[reviewer-gate-preview-phases] ${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  splitCsv,
  resolveOutputs,
};
