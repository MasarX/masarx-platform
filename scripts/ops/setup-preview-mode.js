#!/usr/bin/env node
/**
 * setup-preview-mode.js
 *
 * Toggles CI preview environment strategy:
 * - per-pr  : deterministic project-per-PR (wk-<repo>-pr-<PR#>) created/deleted automatically
 * - shared  : use a single pre-provisioned Supabase project (serialized; no auto-delete)
 *
 * This is idempotent and avoids hardcoding repo IDs (auto-detects owner/repo).
 *
 * Usage:
 *   node scripts/ops/setup-preview-mode.js --mode per-pr [--dry-run] [--owner <o> --repo <r>]
 *   node scripts/ops/setup-preview-mode.js --mode shared --project-name <name> --af38b526-f5c1-468d-88fb-86677fbe872a <ref> [--dry-run]
 *
 * Token:
 *   Set env GITHUB_TOKEN or GH_TOKEN with repo admin permissions.
 */
/* eslint-disable no-console */
const { toBool, autoDetectRepo, deleteVar, upsertVar } = require('./github-actions-vars');

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.replace(/^--/, '');
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    out[key] = val;
  }
  return out;
}

function die(msg) {
  console.error(`[preview-mode] ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs();
  const dryRun = toBool(args['dry-run'] || args.dry, false);

  const modeRaw = String(args.mode || 'per-pr').trim().toLowerCase();
  const mode = modeRaw === 'perpr' ? 'per-pr' : modeRaw;
  if (mode !== 'per-pr' && mode !== 'shared') {
    die(`Invalid --mode ${modeRaw}; expected per-pr or shared.`);
  }

  let owner = String(args.owner || '').trim();
  let repo = String(args.repo || '').trim();
  if (!owner || !repo) {
    const inferred = autoDetectRepo();
    owner = owner || inferred.owner;
    repo = repo || inferred.repo;
  }

  if (!owner || !repo) {
    die('Unable to infer repo. Provide --owner and --repo.');
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token && !dryRun) die('Missing GITHUB_TOKEN or GH_TOKEN in env');

  if (mode === 'per-pr') {
    await deleteVar({ owner, repo, name: 'PREVIEW_PROJECT_NAME', token, dryRun });
    await deleteVar({ owner, repo, name: 'PREVIEW_PROJECT_REF', token, dryRun });
    console.log(`[preview-mode] OK: ${owner}/${repo} now uses project-per-PR previews by default.`);
    return;
  }

  const projectName = String(args['project-name'] || args.project_name || '').trim();
  const projectRef = String(args['af38b526-f5c1-468d-88fb-86677fbe872a'] || args.project_ref || '').trim();
  if (!projectName || !projectRef) {
    die('Shared mode requires --project-name and --af38b526-f5c1-468d-88fb-86677fbe872a');
  }

  await upsertVar({ owner, repo, name: 'PREVIEW_PROJECT_NAME', value: projectName, token, dryRun });
  await upsertVar({ owner, repo, name: 'PREVIEW_PROJECT_REF', value: projectRef, token, dryRun });
  console.log(`[preview-mode] OK: ${owner}/${repo} now uses a shared preview project.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[preview-mode] Failed:', e && e.message ? e.message : String(e));
    process.exit(1);
  });
}
