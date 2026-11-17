#!/usr/bin/env node
/**
 * resolve-prod-surfaces.js
 *
 * Resolves prod target surfaces for a commit SHA.
 *
 * Resolution order:
 * 1) Explicit --surfaces override (manual operator input)
 * 2) Auto mode:
 *    - include surfaces with successful stg deploy workflow runs for SHA
 *    - include prod-only surfaces (no stg stage) when changed in SHA diff
 *
 * Safety posture (fail-closed):
 * - If stg workflow run lookup fails for a staged surface, include it.
 * - If commit-diff lookup fails for prod-only surfaces, include all prod-only surfaces.
 */
/* eslint-disable no-console */

const fs = require('fs');
const {
  loadDeploySurfaceRegistry,
  compileRegistry,
  classifySurfacesForPaths,
  hasStage,
  getStageWorkflowFile,
} = require('./deploy-surface-registry');

function die(msg) {
  console.error(`[resolve-prod-surfaces] ${msg}`);
  process.exit(1);
}

function parseCsv(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return Array.from(new Set(text
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean))).sort();
}

function parseArgs(argv) {
  const out = {
    sha: '',
    surfaces: '',
    repo: '',
    config: '',
    format: '',
  };
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] || '').trim();
    if (!a) continue;
    if (a === '--sha') out.sha = String(args[++i] || '').trim();
    else if (a.startsWith('--sha=')) out.sha = a.split('=').slice(1).join('=').trim();
    else if (a === '--surfaces') out.surfaces = String(args[++i] || '').trim();
    else if (a.startsWith('--surfaces=')) out.surfaces = a.split('=').slice(1).join('=').trim();
    else if (a === '--repo') out.repo = String(args[++i] || '').trim();
    else if (a.startsWith('--repo=')) out.repo = a.split('=').slice(1).join('=').trim();
    else if (a === '--config') out.config = String(args[++i] || '').trim();
    else if (a.startsWith('--config=')) out.config = a.split('=').slice(1).join('=').trim();
    else if (a === '--format') out.format = String(args[++i] || '').trim();
    else if (a.startsWith('--format=')) out.format = a.split('=').slice(1).join('=').trim();
  }
  return out;
}

function writeGithubOutput(kv) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) die('GITHUB_OUTPUT not set; run with --format json locally.');
  const lines = [];
  for (const [k, v] of Object.entries(kv)) {
    lines.push(`${k}=${String(v == null ? '' : v)}`);
  }
  fs.appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

function parseRepoSlug(repo) {
  const value = String(repo || '').trim();
  const match = value.match(/^([^/]+)\/([^/]+)$/);
  if (!match) return { owner: '', repo: '' };
  return { owner: match[1], repo: match[2] };
}

function listSurfaceRows(compiled) {
  return Array.isArray(compiled?.surfaces) ? compiled.surfaces : [];
}

async function ghApiJson({ owner, repo, token, path }) {
  const t = String(token || '').trim();
  if (!t) throw new Error('Missing GitHub token');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${t}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'masarx-resolve-prod-surfaces',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} ${path}: ${text || res.statusText}`);
  }
  return res.json();
}

async function hasSuccessfulWorkflowRunForSha({ owner, repo, token, workflowFile, sha }) {
  const file = String(workflowFile || '').trim();
  if (!file) return false;
  const path = `/actions/workflows/${encodeURIComponent(file)}/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`;
  const payload = await ghApiJson({ owner, repo, token, path });
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  return runs.some((run) => (
    String(run?.status || '').toLowerCase() === 'completed' &&
    String(run?.conclusion || '').toLowerCase() === 'success'
  ));
}

async function resolveSuccessfulStgSurfaces({ owner, repo, token, sha, compiled, logger = console }) {
  const out = [];
  for (const surface of listSurfaceRows(compiled)) {
    if (!hasStage(surface, 'prod') || !hasStage(surface, 'stg')) continue;

    const workflowFile = getStageWorkflowFile(surface, 'stg');
    if (!workflowFile) {
      out.push(surface.surface_id);
      logger.warn?.(`[resolve-prod-surfaces] surface=${surface.surface_id} missing stg workflow mapping; fail-closed include`);
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const ok = await hasSuccessfulWorkflowRunForSha({ owner, repo, token, workflowFile, sha });
      if (ok) out.push(surface.surface_id);
    } catch (err) {
      out.push(surface.surface_id);
      logger.warn?.(`[resolve-prod-surfaces] surface=${surface.surface_id} stg lookup failed (${err.message}); fail-closed include`);
    }
  }
  return Array.from(new Set(out)).sort();
}

async function resolveChangedFilesForCommit({ owner, repo, token, sha }) {
  const commit = await ghApiJson({
    owner,
    repo,
    token,
    path: `/commits/${encodeURIComponent(sha)}`,
  });
  const parents = Array.isArray(commit?.parents) ? commit.parents : [];
  const firstParent = String(parents[0]?.sha || '').trim();
  if (!firstParent) {
    return { changedFiles: [], unknown: true, reason: 'no_parent' };
  }

  const compare = await ghApiJson({
    owner,
    repo,
    token,
    path: `/compare/${encodeURIComponent(firstParent)}...${encodeURIComponent(sha)}`,
  });

  const files = Array.isArray(compare?.files) ? compare.files : [];
  const changedFiles = files
    .map((f) => String(f?.filename || '').trim())
    .filter(Boolean);

  return { changedFiles, unknown: false, reason: '' };
}

function resolveProdOnlySurfaceIds(compiled) {
  return listSurfaceRows(compiled)
    .filter((surface) => hasStage(surface, 'prod') && !hasStage(surface, 'stg'))
    .map((surface) => surface.surface_id)
    .sort();
}

async function resolveChangedProdOnlySurfaces({ owner, repo, token, sha, compiled, logger = console }) {
  const prodOnly = resolveProdOnlySurfaceIds(compiled);
  if (prodOnly.length === 0) return [];

  try {
    const { changedFiles, unknown } = await resolveChangedFilesForCommit({ owner, repo, token, sha });
    if (unknown) return prodOnly;

    const classified = classifySurfacesForPaths(compiled, changedFiles, { failClosed: false });
    const changedSet = new Set(Array.isArray(classified.surfaceIds) ? classified.surfaceIds : []);
    return prodOnly.filter((surfaceId) => changedSet.has(surfaceId)).sort();
  } catch (err) {
    logger.warn?.(`[resolve-prod-surfaces] changed-file detection failed (${err.message}); fail-closed include prod-only surfaces`);
    return prodOnly;
  }
}

function buildOutput(surfaceIds) {
  const list = Array.from(new Set(Array.isArray(surfaceIds) ? surfaceIds : [])).sort();
  return {
    surface_ids: list.join(','),
    skip: list.length ? '0' : '1',
    surfaces_json: JSON.stringify(list),
  };
}

async function resolveProdSurfaces({
  owner,
  repo,
  token,
  sha,
  surfacesInput,
  configPath,
  logger = console,
}) {
  const explicit = parseCsv(surfacesInput);
  if (explicit.length) return explicit;

  const { registry } = loadDeploySurfaceRegistry({ configPath });
  const compiled = compileRegistry(registry);

  const fromStg = await resolveSuccessfulStgSurfaces({ owner, repo, token, sha, compiled, logger });
  const fromChangedProdOnly = await resolveChangedProdOnlySurfaces({ owner, repo, token, sha, compiled, logger });

  return Array.from(new Set([...fromStg, ...fromChangedProdOnly])).sort();
}

async function main() {
  const args = parseArgs();
  const sha = String(args.sha || process.env.DEPLOY_SHA || '').trim();
  if (!sha) die('Missing --sha or DEPLOY_SHA');

  const repoSlug = String(args.repo || process.env.GITHUB_REPOSITORY || '').trim();
  const { owner, repo } = parseRepoSlug(repoSlug);
  if (!owner || !repo) die('Missing --repo (owner/repo) or GITHUB_REPOSITORY');

  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (!token) die('Missing GITHUB_TOKEN/GH_TOKEN');

  const surfaceIds = await resolveProdSurfaces({
    owner,
    repo,
    token,
    sha,
    surfacesInput: args.surfaces || process.env.SURFACES_INPUT || '',
    configPath: args.config,
    logger: console,
  });

  const out = buildOutput(surfaceIds);
  const fmt = String(args.format || process.env.OUTPUT_FORMAT || '').trim().toLowerCase();
  if (fmt === 'github-output') {
    writeGithubOutput(out);
    return;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => die(err && err.message ? err.message : String(err)));
}

module.exports = {
  parseCsv,
  parseArgs,
  parseRepoSlug,
  listSurfaceRows,
  hasStage,
  getStageWorkflowFile,
  hasSuccessfulWorkflowRunForSha,
  resolveSuccessfulStgSurfaces,
  resolveChangedFilesForCommit,
  resolveProdOnlySurfaceIds,
  resolveChangedProdOnlySurfaces,
  buildOutput,
  resolveProdSurfaces,
};
