'use strict';
const fs = require('node:fs');
const { git, targetFile } = require('./target-policy.cjs');
const { assess, exceptions, objectsAt } = require('./migrations.cjs');
const { checkInstallPolicy } = require('./install-policy.cjs');
const markerFile = 'config/ci/protected-path-change-allow.txt';
// Guard runtime imports only; optional workspace fallbacks are not called by the hosted lane.
const guardFiles = new Set([
  'scripts/ops/ci/cloud-pool-db-local.js', 'scripts/ops/ci/cloud-pool-db-local-pgtap.js',
  'scripts/ops/ci/supabase-cli-asset.js', 'scripts/ops/ci/require-cli-version.js', 'scripts/tests/run-pgtap-cloud.js',
  'scripts/utils/load-env.js', 'scripts/utils/env-file.js', 'scripts/qa/qa-log.js',
  'scripts/utils/pg-candidates.js', 'scripts/utils/pg-hostaddr.js',
]);
const protectedFiles = new Set([
  ...guardFiles, 'config/ci/migration-append-only-exceptions.txt', markerFile,
  'config/ci/hosted-db-first-qualification.txt', 'config/ci/hosted-supabase-images.json',
  'config/ci/pgtap-accepted-failures.json', 'config/ci/cloud-pool-db-local.json', 'config/ci/deploy-cli-contract.json', 'config/ci/deploy-surfaces.json',
]);
function lockfile(file) {
  const name = file.split('/').pop().toLowerCase();
  return /\.lockb?$/.test(name) || /(?:^|[-_.])lock(?:file)?\.(?:json|ya?ml)$/.test(name) || name === 'npm-shrinkwrap.json';
}
function packageFile(file) { return /(^|\/)package\.json$/i.test(file); }
function pathClass(file) {
  const f = file.toLowerCase(); const name = f.split('/').pop();
  // Committed dependencies cannot be authorized; guard directories require the base marker.
  if (/(^|\/)node_modules(\/|$)/.test(f)) return 'REJECT';
  if (/^(?:eslint\.config\.|\.eslintrc|\.eslintignore|babel\.config\.|\.babelrc|\.babelignore|jest\.config\.|jest\.setup|setup-jest|playwright.*\.config\.|vitest(?:\.config|\.workspace|\.setup)?\.|ts-jest.*config\.|\.swcrc|\.swcignore|tsconfig.*\.json$|next\.config\.|webpack\.config\.|metro\.config\.|vite\.config\.|postcss\.config\.|tailwind\.config\.)/.test(name)
    && !f.startsWith('.github/') && !f.startsWith('scripts/ci-hosted/')) return 'NOTICE';
  if (f === '.github' || f.startsWith('.github/') || f === 'scripts/ci-hosted' || f.startsWith('scripts/ci-hosted/')
    || protectedFiles.has(f) || /^config\/ci\/known-failures\.[^/]+$/.test(f)
    || f === 'supabase/migrations' || f.startsWith('supabase/migrations/')
    || /^(?:\.gitattributes|\.npmrc|\.?pnpmfile\.[cm]?js|pnpm-workspace\.ya?ml|\.pnp\.(?:cjs|loader\.mjs))$/.test(name)
    || /^\.yarnrc/.test(name) || /(^|\/)\.yarn\/(?:plugins|releases)\//.test(f)) return 'BLOCK';
  return 'NOTICE';
}
function protectedPath(file) { return pathClass(file) === 'BLOCK' && !file.toLowerCase().startsWith('supabase/migrations/'); }
function rejectChanges(changes) {
  const rejected = changes.filter(([, file]) => pathClass(file) === 'REJECT').map(([, file]) => file);
  if (rejected.length) throw new Error(`REJECTED: committed node_modules are forbidden; no marker exception exists: ${JSON.stringify(rejected)}`);
}
function manifestAt(revision, file, read = git) {
  const entry = read(['ls-tree', '-z', revision, '--', file]);
  if (!entry) return {};
  if (!/^100644 blob [a-f0-9]{40}\t/.test(entry)) throw new Error('Manifest must be a plain non-executable file');
  const pkg = JSON.parse(read(['show', `${revision}:${file}`]));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Invalid manifest');
  if (pkg.scripts != null && (typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts))) throw new Error('Invalid manifest scripts');
  return pkg;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function packageManagerChanges(changes, base, candidate, read = git) {
  const blocked = new Set();
  const fields = ['config', 'npmConfig', 'pnpm', 'yarn', 'installConfig', 'devEngines', 'packageManager'];
  for (const [, file] of changes) {
    if (!packageFile(file)) continue;
    const a = manifestAt(base, file, read); const b = manifestAt(candidate, file, read);
    if (fields.some(key => !same(a[key], b[key]))) blocked.add(file);
  }
  return blocked;
}
function inputNotices(changes, blocked = new Set(), log = console.log) {
  const files = changes.filter(([, file]) => pathClass(file) === 'NOTICE' && !blocked.has(file)).map(([, file]) => file);
  if (files.length) {
    log('::notice::CI input change: review what the checks run');
    for (const file of [...new Set(files)].sort()) log(JSON.stringify(file));
  }
  return files;
}
function dependencyNotices(changes, base, candidate, read = git, log = console.log) {
  const files = [];
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions', 'workspaces'];
  for (const [, file] of changes) {
    if (lockfile(file)) files.push(file);
    else if (packageFile(file)) {
      const a = manifestAt(base, file, read); const b = manifestAt(candidate, file, read);
      if (fields.some(key => !same(a[key], b[key]))) files.push(file);
    }
  }
  if (files.length) {
    log('::notice::dependency change: review what the test tools resolve to');
    for (const file of [...new Set(files)].sort()) log(JSON.stringify(file));
  }
  return files;
}
function installInputs(revision, read = git) {
  const names = read(['ls-tree', '-r', '--name-only', '-z', revision, '--', '.github/workflows', 'scripts/ci-hosted']).split('\0').filter(Boolean);
  return new Map(names.filter(name => /^\.github\/workflows\/.*\.ya?ml$|^scripts\/ci-hosted\/.*\.(?:cjs|js|mjs|py)$/.test(name))
    .map(name => [name, read(['show', `${revision}:${name}`])]));
}
function enforceWorkflowInventory(files) {
  const required = ['.github/workflows/policy.yml', '.github/workflows/public-ci.yml'];
  if (required.some(file => !files.has(file))) throw new Error('Required workflow is missing');
  const invalid = [...files.keys()].filter(file => file.startsWith('.github/workflows/') && !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  if (invalid.length) throw new Error('Workflow must be a YAML file directly in the workflow directory');
}
function marker(text, now = new Date()) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length) return null;
  const match = lines.length === 1 && /^allow ([a-zA-Z0-9][a-zA-Z0-9._/-]*) ([a-f0-9]{40}) (\d{4}-\d{2}-\d{2})$/.exec(lines[0]);
  if (!match || match[1].includes('..') || match[1].includes('//') || /[/.]$/.test(match[1])) throw new Error('Malformed protected-path marker');
  const expires = new Date(match[3]);
  if (Number.isNaN(expires.getTime()) || expires.toISOString().slice(0, 10) !== match[3]) throw new Error('Invalid marker expiry');
  return now.toISOString().slice(0, 10) <= match[3] ? { branch: match[1], sha: match[2] } : null;
}
function classify(changes, semantic = new Set()) {
  const guarded = changes.filter(([, file]) => protectedPath(file) || semantic.has(file));
  return { guarded, mixed: guarded.length > 0 && guarded.length !== changes.length };
}
function authorizedPr(allow, head, repository) {
  return Boolean(head?.repo?.full_name && repository)
    && head.repo.full_name.toLowerCase() === repository.toLowerCase()
    && head.ref === allow.branch && head.sha === allow.sha;
}
const sha = value => {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error('Missing/invalid event SHA');
  return value;
};
function policySource(event, kind) {
  let branch; let base;
  if (kind === 'pull_request_target') {
    branch = event.pull_request?.base?.ref;
    base = event.pull_request?.base?.sha;
  } else if (kind === 'merge_group') {
    branch = event.merge_group?.base_ref?.replace(/^refs\/heads\//, '');
    base = event.merge_group?.base_sha;
  } else throw new Error('Unsupported policy event');
  if (!['preview', 'dev', 'main'].includes(branch)) throw new Error('Unsupported target branch');
  return sha(base);
}
function devPromotion(event, kind, repository, read = git) {
  if (kind !== 'pull_request_target') return false;
  const pr = event.pull_request;
  const target = pr?.base?.ref;
  if (target === 'main' && pr?.head?.ref !== 'dev') throw new Error('Main accepts only a current same-repository dev promotion');
  if (!['main', 'preview'].includes(target) || pr?.head?.ref !== 'dev') return false;
  const head = pr.head;
  const baseRepo = pr.base.repo;
  if (!repository || !head.repo || !baseRepo || head.repo.fork !== false
    || !Number.isSafeInteger(baseRepo.id) || baseRepo.id < 1 || head.repo.id !== baseRepo.id
    || baseRepo.full_name?.toLowerCase() !== repository.toLowerCase()
    || head.repo.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Dev promotion requires complete same-repository identity; forks are refused');
  }
  const headSha = sha(head.sha);
  read(['fetch', '--no-tags', '--depth=1', 'origin', '+refs/heads/dev:refs/policy/dev']);
  if (sha(read(['rev-parse', 'refs/policy/dev']).trim()) !== headSha) throw new Error('Dev promotion head is stale');
  return true;
}
function liveMerge(event, read = git, pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)) {
  const number = event.pull_request?.number;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Missing/invalid PR number');
  const head = sha(event.pull_request?.head?.sha);
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      read(['fetch', '--no-tags', '--depth=2', 'origin', `+refs/pull/${number}/merge:refs/policy/candidate`], 'utf8', undefined, 30000);
      const candidate = sha(read(['rev-parse', 'refs/policy/candidate']).trim());
      if (read(['rev-parse', `${candidate}^2`]).trim() === head) return { candidate, base: sha(read(['rev-parse', `${candidate}^1`]).trim()) };
    } catch (error) { if (attempt === 6) throw new Error('Live PR test-merge ref unavailable after six bounded attempts'); }
    if (attempt < 6) pause();
  }
  throw new Error('Live PR test-merge ref does not match event head after six attempts');
}
function closedMarker(text) { return !text.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#')); }
function enforceMarker(changes, candidateText, authorized, now = new Date(), kind = 'pull_request') {
  const changed = changes.some(([, file]) => file === markerFile);
  if (changed && changes.length !== 1 && kind !== 'merge_group') throw new Error('Marker changes must touch ONLY the marker');
  if (changed && !closedMarker(candidateText)) {
    marker(candidateText, now);
    throw new Error('Marker opening requires the documented administrator PR-only bypass');
  }
}
function enforceScope(scope, kind) {
  if (scope.mixed && kind !== 'merge_group') throw new Error('Protected-path changes must touch nothing outside protected paths');
}
function main() {
  // The workflow runs this file from the target base; candidate Git objects are data only.
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const kind = process.env.GITHUB_EVENT_NAME;
  const source = policySource(event, kind);
  const promotion = devPromotion(event, kind, process.env.GITHUB_REPOSITORY);
  let base; let candidate;
  if (kind === 'pull_request_target') {
    ({ candidate, base } = liveMerge(event));
  } else if (kind === 'merge_group') {
    base = sha(event.merge_group?.base_sha);
    candidate = sha(event.merge_group?.head_sha);
    for (const ref of [base, candidate]) git(['fetch', '--no-tags', '--depth=64', 'origin', ref]);
  } else throw new Error('Unsupported policy event');
  if (base !== source) throw new Error('Candidate base differs from the trusted policy source');
  const fields = git(['diff', '--no-renames', '--name-status', '-z', base, candidate]).split('\0').filter(Boolean);
  if (fields.length % 2) throw new Error('Malformed candidate diff');
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) changes.push([fields[i], fields[i + 1]]);
  rejectChanges(changes);
  dependencyNotices(changes, base, candidate);
  const managerChanges = packageManagerChanges(changes, base, candidate);
  inputNotices(changes, managerChanges);
  const installFiles = installInputs(candidate);
  enforceWorkflowInventory(installFiles);
  const installErrors = checkInstallPolicy(installFiles);
  if (installErrors.length) throw new Error(`CI install policy violation: ${JSON.stringify(installErrors)}`);
  const baseFiles = git(['ls-tree', '-r', '--name-only', '-z', base, '--', 'supabase/migrations/']).split('\0').filter(Boolean);
  const migrations = assess(baseFiles, changes.filter(([, file]) => file.startsWith('supabase/migrations/')),
    exceptions(targetFile('config/ci/migration-append-only-exceptions.txt', base)),
    objectsAt(candidate, changes.filter(([, file]) => file.startsWith('supabase/migrations/'))));
  for (const file of migrations.tolerated) console.log(`TOLERATED migration exception from target branch: ${file}`);
  if (migrations.failed.length) throw new Error(`Append-only violation: ${JSON.stringify(migrations.failed)}`);
  const scope = classify(changes, managerChanges);
  if (!promotion) enforceScope(scope, kind);
  const candidateMarker = targetFile(markerFile, candidate);
  enforceMarker(changes, candidateMarker, false, new Date(), kind);
  const authorityFiles = scope.guarded.filter(([, file]) => file !== markerFile || !closedMarker(candidateMarker));
  if (authorityFiles.length && !promotion) {
    const allow = marker(targetFile(markerFile, base));
    if (!allow) throw new Error('Protected-path changes denied: target marker is closed or expired');
    if (kind === 'merge_group') {
      // Bind queue changes to the authorized same-repository branch, commit and file blobs.
      git(['fetch', '--no-tags', '--depth=1', 'origin', `refs/heads/${allow.branch}`]);
      if (git(['rev-parse', 'FETCH_HEAD']).trim() !== allow.sha) throw new Error('Authorized branch head changed');
      git(['merge-base', '--is-ancestor', allow.sha, candidate]);
      for (const [, file] of authorityFiles) {
        if (git(['ls-tree', '-z', candidate, '--', file]) !== git(['ls-tree', '-z', allow.sha, '--', file])) {
          throw new Error('Queued protected-file content differs from the authorized head');
        }
      }
    } else if (!authorizedPr(allow, event.pull_request.head, process.env.GITHUB_REPOSITORY)) {
      throw new Error('Protected-path PR does not match the target-authorized same-repository branch and head');
    }
    for (const [, file] of scope.guarded) console.log(`TOLERATED protected-only change: ${JSON.stringify(file)}`);
  }
  if (promotion) console.log('PASS: current same-repository dev promotion; protected paths were guarded on entry to dev');
  console.log('PASS: target-branch policy, protected-path scope and append-only migrations');
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { pathClass, protectedPath, protectedFiles, guardFiles, packageManagerChanges, inputNotices, manifestAt, dependencyNotices, lockfile, installInputs, enforceWorkflowInventory, marker, classify, authorizedPr, liveMerge, enforceMarker, enforceScope, rejectChanges, policySource, devPromotion };
