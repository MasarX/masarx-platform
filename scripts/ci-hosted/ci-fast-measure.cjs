'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { qualify } = require('./backend.cjs');
const { stage } = require('./process.cjs');

const mode = process.argv[2];
const cache = process.env.MEASURE_CACHE;
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !cache) throw new Error('Hosted measurement only');
const pins = require('../../config/ci/hosted-supabase-images.json');
const out = 'ci-fast-evidence';
const report = { mode, stages: [], sha: process.env.GITHUB_SHA, cacheLimitBytes: 10 * 1024 ** 3 };
const alias = pin => 'public.ecr.aws/' + pin.image + ':' + pin.cli_tag;
const selected = set => set === 'minimal' ? pins.filter(pin => pin.role === 'database') : pins;
const timed = (name, action) => stage(report, name, action);
const docker = (args, options) => command('docker', args, options);
const bash = (script, ...args) => command('bash', ['-o', 'pipefail', '-ec', script, 'measure', ...args]);
function command(file, args, { input, capture = false } = {}) {
  const result = spawnSync(file, args, { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'], maxBuffer: 128 * 1024 ** 2 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(file + ' exited ' + (result.status ?? result.signal));
  return result.stdout?.trim();
}
function verify(images) {
  for (const pin of images) {
    const id = docker(['image', 'inspect', '--format', '{{.Id}}', alias(pin)], { capture: true });
    if (id !== pin.image_id) throw new Error('Image identity mismatch for ' + pin.image);
    pin.runtimeId = id;
  }
}
function imageArchive(set) { return path.join(cache, set + '.tar.zst'); }
async function archiveImages() {
  const images = selected(mode);
  report.images = images;
  await timed('cold-pull', () => Promise.all(images.map(pin => new Promise((resolve, reject) => {
    const reference = pin.mirror + '/' + pin.image + '@' + pin.digest;
    const pull = spawn('docker', ['pull', '--platform', 'linux/amd64', reference], { stdio: 'inherit' });
    pull.once('error', reject);
    pull.once('exit', code => {
      if (code !== 0) return reject(new Error('Digest pull failed for ' + pin.role));
      try { docker(['tag', reference, alias(pin)]); resolve(); } catch (error) { reject(error); }
    });
  }))));
  verify(images);
  await timed('docker-save-zstd', () => bash('archive=$1; shift; docker save "$@" | zstd -T2 -3 -o "$archive"', imageArchive(mode), ...images.map(alias)));
  report.archiveBytes = fs.statSync(imageArchive(mode)).size;
  report.freeBytesAfterArchive = fs.statfsSync(cache).bavail * fs.statfsSync(cache).bsize;
}
async function load(set) {
  await timed('docker-load-' + set, () => bash('zstd -dc "$1" | docker load', imageArchive(set)));
  verify(selected(set));
  // Remove the minimal image before the full test so both start with an empty measured image set.
  if (set === 'minimal') docker(['image', 'rm', ...selected(set).map(alias)]);
}
const dbContainer = project => 'supabase_db_' + project;
function sql(project, text) {
  return docker(['exec', '-i', dbContainer(project), 'sh', '-ec',
    'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -XqAt -v ON_ERROR_STOP=1 -h 127.0.0.1 -U supabase_admin -d postgres'], { input: text, capture: true });
}
function fingerprint(project) {
  return crypto.createHash('sha256').update(sql(project, fs.readFileSync('scripts/ci-hosted/ci-fast-fingerprint.sql', 'utf8'))).digest('hex');
}
function postgresArchive(project, file, restore = false) {
  const container = dbContainer(project);
  const directory = sql(project, 'SHOW data_directory;');
  const external = sql(project, "SELECT count(*) FROM pg_tablespace WHERE pg_tablespace_location(oid) <> '';");
  if (!directory.startsWith('/') || directory === '/' || external !== '0') throw new Error('Unsupported database storage layout');
  const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', container], { capture: true }));
  if (!mounts.some(entry => directory === entry.Destination || directory.startsWith(entry.Destination + '/'))) throw new Error('Postgres data volume missing');
  docker(['stop', container]);
  try {
    const helper = ['run', '--rm', '-i', '--user', '0', '--volumes-from', container + (restore ? ':rw' : ':ro'), '--entrypoint', 'sh', alias(selected('minimal')[0])];
    if (restore) {
      bash('archive=$1; shift; zstd -dc "$archive" | docker "$@"', file, ...helper,
        '-ec', 'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar --numeric-owner -xpf - -C "$1"', 'restore', directory);
    } else {
      bash('archive=$1; shift; docker "$@" | zstd -T2 -3 -o "$archive"', file, ...helper,
        '-ec', 'tar --numeric-owner -cpf - -C "$1" .', 'snapshot', directory);
    }
  } finally {
    docker(['start', container]);
  }
  docker(['exec', container, 'sh', '-ec', 'for i in $(seq 1 60); do pg_isready -h 127.0.0.1 && exit 0; sleep 1; done; exit 1']);
}
function runBackend(options) {
  return qualify({ stage: 'image-preflight' }, { installed: true, ...options,
    images: current => verify(options.minimal ? current.filter(pin => pin.role === 'database') : current) });
}
const migrations = path.resolve('supabase/migrations');
const database = path.join(cache, 'database');
const snapshot = n => path.join(database, 'baseline-' + n + '.tar.zst');
const files = () => fs.readdirSync(migrations).filter(file => file.endsWith('.sql')).sort();
const replay = ({cli, cliEnv, temp, checked}) => checked(cli, ['migration', 'up', '--local', '--workdir', temp], cliEnv, 600_000);
function linkFiles(target, inventory) {
  for (const file of inventory) fs.symlinkSync(path.join(migrations, file), path.join(target, file));
}
function selection(project, target = 'object-map.json') {
  const payload = sql(project, fs.readFileSync('scripts/ci-hosted/ci-fast-catalog.sql', 'utf8'));
  command('python3', ['scripts/ci-hosted/ci-fast-selection.py', 'map', path.join(out, target)], { input: payload });
}
async function build() {
  fs.mkdirSync(database, { recursive: true });
  await runBackend({ afterReplay: async ({ project, summary }) => {
    report.replay = summary.stages.filter(entry => ['stack-start', 'migrations'].includes(entry.name));
    report.fingerprint = fingerprint(project);
    await timed('snapshot-full', () => postgresArchive(project, snapshot(0)));
    fs.writeFileSync(path.join(database, 'fingerprint'), report.fingerprint + '\n');
    await timed('selection-map', () => selection(project));
  } });
  const prefix = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'migration-prefix-'));
  const inventory = files();
  linkFiles(prefix, inventory.slice(0, -20));
  await runBackend({ migrationDirectory: prefix, afterReplay: async context => {
    for (const [n, next] of [[20, 5], [5, 1], [1, 1]]) {
      await timed('snapshot-prefix-' + n, () => postgresArchive(context.project, snapshot(n)));
      if (n === next) break;
      linkFiles(prefix, inventory.slice(-n, -next));
      await replay(context);
    }
  } });
  report.databaseArchiveBytes = Object.fromEntries([0, 1, 5, 20].map(n => [n, fs.statSync(snapshot(n)).size]));
}
async function minimal() {
  const required = ['pg_cron', 'pg_net', 'pg_stat_statements', 'pg_trgm', 'pgcrypto', 'pgtap', 'postgis', 'supabase_vault'];
  try {
    await runBackend({ minimal: true, beforeReplay: ({ project, summary }) => {
      report.postgresOnlyStack = summary.stages.find(entry => entry.name === 'stack-start');
      const running = docker(['ps', '--format', '{{.Names}}'], { capture: true }).split('\n');
      if (running.filter(name => name.endsWith('_' + project)).join() !== dbContainer(project)) throw new Error('Unexpected stack containers');
      const available = sql(project, 'SELECT name FROM pg_available_extensions ORDER BY name;').split('\n');
      report.extensions = { required, missing: required.filter(name => !available.includes(name)) };
      if (report.extensions.missing.length) throw new Error('Image is missing migration extensions');
    }, afterReplay: ({ project }) => { report.fingerprint = fingerprint(project); } });
    report.minimalReplay = 'PASSED';
  } catch (error) {
    const backend = JSON.parse(fs.readFileSync('ci-reports/backend.json', 'utf8'));
    report.minimalReplay = { result: 'FAILED', stages: backend.stages, firstFailingMigration: backend.firstFailingMigration, failure: backend.failure?.message ?? error.message };
    fs.copyFileSync('ci-reports/backend.log', path.join(out, 'minimal-db.log'));
  }
}
async function restore() {
  await load('minimal');
  await load('full');
  const expected = fs.readFileSync(path.join(database, 'fingerprint'), 'utf8').trim();
  report.prefixes = {};
  try {
    await runBackend({ minimal: true, beforeOnly: true, beforeReplay: async ({ project, summary }) => {
      report.minimalRestored = { stack: summary.stages.find(entry => entry.name === 'stack-start') };
      await timed('restore-minimal', () => postgresArchive(project, snapshot(0), true));
      report.minimalRestored.matches = fingerprint(project) === expected;
    } });
  } catch (error) {
    report.minimalRestored = { ...report.minimalRestored, status: 'FAILED', reason: error.message };
  }
  for (const n of [0, 1, 5, 20]) {
    await runBackend({ beforeOnly: true, beforeReplay: async context => {
      const { project, temp, summary } = context;
      if (n === 0) report.fullStackStart = summary.stages.find(entry => entry.name === 'stack-start');
      await timed('restore-' + n, () => postgresArchive(project, snapshot(n), true));
      if (n) {
        const inventory = files();
        linkFiles(path.join(temp, 'supabase/migrations'), inventory);
        await timed('apply-' + n, () => replay(context));
        const versions = sql(project, 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;').split('\n');
        if (versions.join() !== inventory.map(file => file.split('_')[0]).join()) throw new Error('Migration inventory mismatch');
      }
      const actual = fingerprint(project);
      report.prefixes[n] = { fingerprint: actual, matches: actual === expected };
    } });
  }
  if (Object.values(report.prefixes).some(row => !row.matches)) throw new Error('Baseline fingerprint mismatch');
}
async function hidden() {
  await load('full');
  await runBackend({ beforeOnly: true, beforeReplay: async ({ project }) => {
    await timed('hidden-restore', () => postgresArchive(project, snapshot(0), true));
    const query = text => sql(project, text);
    const migration = path.join(migrations, '99999999999999_measure_dependency.sql');
    const fixture = 'supabase/tests/pgtap/049_geocoding_normalize_candidate_code.sql';
    const test = fs.readFileSync(fixture, 'utf8');
    const body = expression => 'CREATE OR REPLACE FUNCTION public.measure_leaf(text, text) RETURNS text LANGUAGE sql AS $$ SELECT ' + expression + ' $$;';
    // Install an equivalent call through the drill leaf, then change only that leaf.
    query('ALTER FUNCTION public.geocoding_normalize_candidate_code(text, text) RENAME TO measure_original;'
      + body('public.measure_original($1, $2)')
      + ' CREATE FUNCTION public.geocoding_normalize_candidate_code(text, text) RETURNS text LANGUAGE sql AS $$ SELECT public.measure_leaf($1, $2) $$;');
    fs.writeFileSync(migration, body('NULL::text'), { flag: 'wx' });
    try {
      const green = query(test);
      if (!/^ok 2 - Normalizes candidate and validates against regex$/m.test(green) || /^not ok /m.test(green)) throw new Error('Green control failed');
      selection(project, 'hidden-object-map.json');
      const proof = command('python3', ['scripts/ci-hosted/ci-fast-selection.py', 'proof', path.join(out, 'hidden-object-map.json'), path.basename(migration), path.basename(fixture)], { capture: true });
      query(fs.readFileSync(migration, 'utf8'));
      const red = query(test);
      if (!/^not ok 2 - Normalizes candidate and validates against regex$/m.test(red)) throw new Error('Expected TAP assertion failure missing');
      report.hidden = { ...JSON.parse(proof), green, red };
    } finally {
      fs.rmSync(migration);
    }
  } });
}
async function main() {
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  try {
    if (mode === 'full' || mode === 'minimal') await archiveImages();
    else if (mode === 'build') await build();
    else if (mode === 'minimal-db') await minimal();
    else if (mode === 'restore') await restore();
    else if (mode === 'hidden') await hidden();
    else throw new Error('Unknown measurement mode');
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    const json = JSON.stringify(report, null, 2) + '\n';
    fs.writeFileSync(path.join(out, mode + '.json'), json);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n```json\n' + json + '\n```\n');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
