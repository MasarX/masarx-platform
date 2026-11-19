'use strict';
const { execFileSync } = require('node:child_process');

const gates = ['database', 'typecheck', 'unit', 'ui', 'build_console', 'build_portal', 'build_landing', 'e2e'];
const state = value => Object.fromEntries(gates.map(gate => [gate, value]));
const sharedInputs = [
  /^(?:\.github|scripts\/ci-hosted|config)\/|(?:^|\/)\.yarn\//,
  /(?:^|\/)(?:[^/]*manifest[^/]*\.(?:jsonc?|ya?ml|toml|xml)|(?:package|project|deno|composer)\.jsonc?|[^/]+\.webmanifest)$/i,
  /(?:^|\/)(?:[^/]+\.lock(?:\.[^/]+)?|(?:[^/]+-)?lock\.[^/]+|bun\.lockb|npm-shrinkwrap\.json|pnpm-workspace\.ya?ml)$/i,
  /(?:^|\/)(?:\.npmrc|\.yarnrc(?:\.[^/]+)?|\.pnpmfile\.[^/]+|\.gitattributes|cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|gemfile|go\.(?:mod|sum))$/i,
];

function select(files) {
  if (!files) return state(true);
  const affected = state(false);
  for (const file of files) {
    if (sharedInputs.some(pattern => pattern.test(file))) return state(true);
    if (file.startsWith('supabase/')) affected.database = true;
    else if (file.startsWith('apps/console/')) affected.typecheck = affected.build_console = true;
    else if (file.startsWith('apps/portal/')) affected.typecheck = affected.build_portal = true;
    else if (file.startsWith('apps/fieldops/')) affected.typecheck = true;
    else if (file.startsWith('tests/unit/')) affected.unit = true;
    else if (/^(?:tests\/ui|packages)\//.test(file)) affected.ui = true;
    else if (/^(?:apps\/landing|docs\/marketing\/(?:landing-v2|brand))\/|^scripts\/frontend\/(?:build|serve)-landing\.js$/.test(file)) {
      affected.build_landing = affected.e2e = true;
    } else if (/^tests\/landing-e2e\/|^playwright\.landing\.config\.ts$/.test(file)) affected.e2e = true;
    else if (!/^(?:docs\/(?:[^/]+\/)*)?[^/]+\.(?:md|mdx)$/i.test(file)) return state(true);
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
  for (const [gate, enabled] of Object.entries(select(files))) console.log(`${gate}=${enabled}`);
}
module.exports = { changedPaths, select };
