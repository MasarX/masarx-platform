'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { run: checked, retry } = require('./process.cjs');

const root = process.cwd();
const exists = file => fs.existsSync(path.join(root, file));
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const nextApps = () => !exists('apps') ? [] : fs.readdirSync('apps').filter(name => {
  const file = `apps/${name}/package.json`;
  return exists(file) && Boolean(read(file).dependencies?.next || read(file).devDependencies?.next);
});
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error(`${command} failed`);
}
function npmScript(name, prefix) {
  const manifest = prefix ? read(`${prefix}/package.json`) : read('package.json');
  if (!manifest.scripts?.[name]) throw new Error(`Missing script ${prefix || '.'}:${name}`);
  run('npm', [...(prefix ? ['--prefix', prefix] : []), 'run', name]);
}
function detect(subject) {
  let present;
  if (subject === 'database') present = exists('supabase/migrations');
  else if (subject === 'unit' || subject === 'ui') present = exists(`tests/${subject}`);
  else if (subject === 'lint') present = exists('apps') || exists('packages') || exists('supabase/migrations');
  else if (subject === 'typecheck') present = nextApps().length > 0 || exists('apps/fieldops/tsconfig.json');
  else if (subject === 'landing') present = exists('scripts/frontend/build-landing.js');
  else if (subject.startsWith('apps/')) present = exists(`${subject}/package.json`);
  else throw new Error('Unknown subject');
  const result = present ? 'present' : 'skipped-by-design: subject absent';
  console.log(`${subject}: ${result}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `present=${present}\n`);
}
async function install(checked) {
  const manager = read('package.json').packageManager;
  if (!/^npm@\d+\.\d+\.\d+$/.test(manager || '')) throw new Error('Exact npm packageManager required');
  await retry('npm version installation', () => checked('npm', ['install', '--global', manager, '--ignore-scripts', '--no-audit', '--no-fund']));
  return retry('npm ci', () => checked('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']));
}
async function main() {
  const [command, subject] = process.argv.slice(2);
  if (command === 'detect') return detect(subject);
  if (command === 'install') return install(checked);
  if (command === 'lint') {
    for (const name of ['lint:docs:ssot', 'lint:frontend', 'lint:commands', 'lint:structure', 'lint:ingress-worker']) {
      npmScript(name);
    }
    if (exists('supabase/migrations')) {
      process.env.MIGRATION_FIXTURE_GUARD_MODE = 'full';
      npmScript('lint:db:fixtures');
      npmScript('lint:db:managed-grants');
    }
    return;
  }
  if (command === 'typecheck') {
    if (!subject) throw new Error('Typecheck app is required');
    if (subject === 'apps/fieldops') return npmScript('typecheck:fieldops');
    // Console V2 is a Vite app, so it has its own tsc script rather than the Next typegen path.
    if (subject === 'apps/console-v2') {
      // src/routeTree.gen.ts is gitignored and written by the Vite router plugin, so generate it before tsc.
      // The plugin options in vite.config.ts are the generator defaults, so getConfig({}) matches them.
      const appRoot = path.resolve(subject);
      const { Generator, getConfig } = require(require.resolve('@tanstack/router-generator', { paths: [appRoot] }));
      await new Generator({ config: getConfig({}, appRoot), root: appRoot }).run();
      return npmScript('typecheck', subject);
    }
    if (!nextApps().some(app => `apps/${app}` === subject)) throw new Error('Typecheck subject must be a Next app');
    for (const app of nextApps().filter(app => `apps/${app}` === subject)) {
      const dir = `apps/${app}`;
      if (!exists(`${dir}/tsconfig.json`)) throw new Error(`Missing ${dir}/tsconfig.json`);
      // Resolve each app's Next/TS installation, including nested workspace versions.
      const next = require.resolve('next/dist/bin/next', { paths: [path.resolve(dir)] });
      const tsc = require.resolve('typescript/bin/tsc', { paths: [path.resolve(dir)] });
      for (const args of [[next, 'typegen'], [tsc, '--noEmit']]) {
        const result = spawnSync(process.execPath, args, { cwd: dir, stdio: 'inherit', env: process.env });
        if (result.error || result.status !== 0) throw new Error(`Typecheck failed: ${dir}`);
      }
    }
    return;
  }
  if (command === 'build') {
    if (subject === 'landing') return npmScript('build:landing');
    if (!nextApps().some(app => `apps/${app}` === subject)) throw new Error('Build subject must be a Next app');
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = crypto.randomBytes(32).toString('hex');
    return npmScript('build', subject);
  }
  const suites = { 'landing-e2e': 'landing', 'console-a11y': 'console-a11y' };
  if (command === 'browser-install' || suites[command]) {
    const args = command === 'browser-install' ? ['install', '--with-deps', 'chromium']
      : ['test', '-c', `scripts/ci-hosted/playwright.${suites[command]}.config.cjs`];
    return run(process.execPath, [require.resolve('@playwright/test/cli'), ...args]);
  }
  if (command === 'visual' || command === 'visual-preflight') {
    for (const file of [
      'tests/e2e/console-visual.spec.ts', 'tests/e2e/portal-visual.spec.ts',
      'tests/e2e/utils/visual.ts', 'tests/ui/visual-snapshot-locale.test.ts',
      'tests/unit/e2e/visual-navigation-readiness.test.js',
      'playwright.hosted-visual.config.ts',
    ]) if (!exists(file)) throw new Error(`Visual prerequisite missing: ${file}`);
    if (command === 'visual-preflight') return;
    // The dedicated config must own its local servers/fixtures and deny external network.
    run(process.execPath, [require.resolve('@playwright/test/cli'), 'test',
      '-c', 'playwright.hosted-visual.config.ts', '--update-snapshots', '--workers=2', '--retries=0',
      'tests/e2e/console-visual.spec.ts', 'tests/e2e/portal-visual.spec.ts']);
    const snapshots = fs.globSync('tests/e2e/**/*-snapshots/*.png');
    const bytes = snapshots.reduce((sum, file) => sum + fs.statSync(file).size, 0);
    if (!snapshots.length || bytes > 64 * 1024 * 1024) throw new Error('Visual artifact must contain PNG baselines and stay below 64 MiB');
    return;
  }
  throw new Error('Unknown command');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { nextApps, detect, install };
