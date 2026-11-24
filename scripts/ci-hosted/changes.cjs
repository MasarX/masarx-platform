'use strict';
const { execFileSync } = require('node:child_process');

const gates = ['database', 'typecheck', 'unit', 'ui', 'build_console', 'build_portal', 'build_landing', 'e2e'];
const state = value => Object.fromEntries(gates.map(gate => [gate, value]));
const cdPaths = new Set([
  '.github/workflows/deploy.yml',
  '.github/workflows/provenance-on-tag.yml',
  'tests/unit/ops/dev-db-dry-run-workflow.test.js',
  'tests/unit/ops/release-workflow.test.js',
]);
const sharedInputs = [
  /^(?:\.github|scripts\/ci-hosted|config|packages)\/|(?:^|\/)\.yarn\//,
  /(?:^|\/)(?:[^/]*manifest[^/]*\.(?:jsonc?|ya?ml|toml|xml)|(?:package|project|deno|composer)\.jsonc?|[^/]+\.webmanifest)$/i,
  /(?:^|\/)(?:[^/]+\.lock(?:\.[^/]+)?|(?:[^/]+-)?lock\.[^/]+|bun\.lockb|npm-shrinkwrap\.json|pnpm-workspace\.ya?ml)$/i,
  /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.[^/]+)?|\.pnpmfile\.[^/]+|\.gitattributes|cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|gemfile|go\.(?:mod|sum))$/i,
];

function select(files, event = 'pull_request') {
  if (!files || event !== 'pull_request') return state(true);
  const cdFiles = files.filter(file => cdPaths.has(file)).length;
  const cdOnly = cdFiles > 0 && cdFiles === files.length;
  const affected = state(false);
  affected.database = cdFiles > 0 && !cdOnly;
  for (const file of files) {
    if (sharedInputs.some(pattern => pattern.test(file))) return { ...state(true), database: !cdOnly };
    if (file.startsWith('supabase/')) affected.database = affected.unit = true;
    else if (file.startsWith('apps/')) {
      const [, app] = file.split('/');
      affected.typecheck = affected.unit = affected.ui = true;
      if (app === 'console' || app === 'portal') affected[`build_${app}`] = true;
      else if (app === 'landing') affected.build_landing = affected.e2e = true;
      else if (app === 'fieldops') {
        // FieldOps has no hosted build target.
        affected.build_console = affected.build_portal = affected.build_landing = true;
      } else return state(true);
    } else if (/^docs\/marketing\/(?:landing-v2|brand)\/|^scripts\/frontend\/(?:build|serve)-landing\.js$/.test(file)) {
      affected.unit = affected.build_landing = affected.e2e = true;
    } else if (/^(?:tests\/unit|docs)\//.test(file) || /^(?:AGENTS|DELIVERY|DESIGN|CLAUDE)\.md$/.test(file)) affected.unit = true;
    else if (file.startsWith('tests/ui/')) affected.ui = true;
    else if (/^tests\/landing-e2e\/|^playwright\.landing\.config\.ts$/.test(file)) affected.e2e = true;
    else if (!/^[^/]+\.md$/i.test(file)) return state(true);
  }
  return affected;
}

function changedPaths(base, read = execFileSync) {
  if (!/^[a-f0-9]{40}$/.test(base || '')) throw new Error('Invalid change-selection base');
  const raw = read('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--'], {
    maxBuffer: 4 * 1024 * 1024, timeout: 30000,
  });
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  if (text && !text.endsWith('\0')) throw new Error('Incomplete changed path list');
  return text ? text.slice(0, -1).split('\0') : [];
}

if (require.main === module) {
  let files;
  try { files = changedPaths(process.argv[2]); }
  catch { console.error('Changed paths unavailable; running every job.'); }
  for (const [gate, enabled] of Object.entries(select(files, process.env.GITHUB_EVENT_NAME))) {
    console.log(`${gate}=${enabled}`);
  }
}
module.exports = { changedPaths, select };
