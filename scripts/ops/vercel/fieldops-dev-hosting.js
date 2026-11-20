const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FIELDOPS_BASE_PATH = '/fieldops';
const REQUIRED_FILES = [
  'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'register-sw.js', 'sw.js',
];

function isFieldopsDevHosting({ env, workspace }) {
  if (env.NEXT_PUBLIC_FIELDOPS_DEV_HOSTING !== '1') return false;
  if (workspace !== '@masarx/console' || env.MASARX_VERCEL_STAGE !== 'dev') {
    throw new Error('FieldOps hosting is restricted to Console DEV.');
  }
  return true;
}

function fieldopsBuildEnv(env) {
  return {
    ...env,
    NEXT_PUBLIC_APP_BASE_PATH: FIELDOPS_BASE_PATH,
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY,
    EXPO_NO_TELEMETRY: '1',
  };
}

function validateFieldopsDevConfig({ cwd, env, spawnSyncImpl = spawnSync }) {
  const result = spawnSyncImpl(process.execPath, [
    path.join(cwd, 'scripts', 'ops', 'mobile', 'run-fieldops-expo.js'),
    'config', '--type', 'public', '--json',
  ], { cwd, env: fieldopsBuildEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error('FieldOps public Expo config could not be resolved.');
  let config;
  try { config = JSON.parse(result.stdout); } catch { throw new Error('FieldOps public Expo config returned invalid JSON.'); }
  if (config?.experiments?.baseUrl !== FIELDOPS_BASE_PATH) {
    throw new Error('FieldOps app.config must set experiments.baseUrl to /fieldops; Source prerequisite is missing.');
  }
}

function validateFieldopsExport(exportDir, fsImpl = fs) {
  for (const name of REQUIRED_FILES) {
    const file = path.join(exportDir, name);
    if (!fsImpl.existsSync(file) || !fsImpl.lstatSync(file).isFile() || fsImpl.statSync(file).size === 0) {
      throw new Error(`Missing FieldOps export file: ${name}`);
    }
  }
  const manifest = JSON.parse(fsImpl.readFileSync(path.join(exportDir, 'manifest.json'), 'utf8'));
  if (manifest.display !== 'standalone' || manifest.start_url !== './' || manifest.scope !== './') {
    throw new Error('FieldOps manifest must retain its relative start URL and scope.');
  }
  for (const name of ['icon-192.png', 'icon-512.png']) {
    if (!Array.isArray(manifest.icons) || !manifest.icons.some((icon) => icon.src === `./${name}`)) {
      throw new Error('FieldOps manifest must reference both supplied relative icons.');
    }
  }
  const html = fsImpl.readFileSync(path.join(exportDir, 'index.html'), 'utf8');
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\bsrc\s*=/i.test(script[1]) && script[2].trim() &&
        !/\btype\s*=\s*["'](?:application|text)\/(?:json|ld\+json)["']/i.test(script[1])) {
      throw new Error('FieldOps export contains inline executable scripts unsupported by its static CSP.');
    }
  }
  const references = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], `https://fieldops.invalid${FIELDOPS_BASE_PATH}/`));
  if (!references.some((url) => url.pathname.startsWith(`${FIELDOPS_BASE_PATH}/_expo/static/`))) {
    throw new Error('FieldOps export lacks /fieldops-prefixed Expo assets; Source baseUrl prerequisite is missing.');
  }
  for (const name of ['manifest.json', 'register-sw.js', 'icon-192.png']) {
    if (!references.some((url) => url.pathname === `${FIELDOPS_BASE_PATH}/${name}`)) {
      throw new Error('FieldOps HTML must reference its manifest, worker registration and Apple touch icon.');
    }
  }
  for (const url of references) {
    if (url.origin !== 'https://fieldops.invalid' || !url.pathname.startsWith(`${FIELDOPS_BASE_PATH}/`)) {
      throw new Error('FieldOps export contains a resource outside /fieldops/.');
    }
    const relative = decodeURIComponent(url.pathname.slice(FIELDOPS_BASE_PATH.length + 1));
    const file = path.resolve(exportDir, relative);
    if (!file.startsWith(`${path.resolve(exportDir)}${path.sep}`) ||
        !fsImpl.existsSync(file) || !fsImpl.lstatSync(file).isFile()) {
      throw new Error('FieldOps export references a missing or unsafe static resource.');
    }
  }
  function checkFiles(dir) {
    for (const name of fsImpl.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fsImpl.lstatSync(file);
      if (stat.isSymbolicLink() || /^\.env(?:\.|$)/i.test(name)) {
        throw new Error('FieldOps export must not contain symlinks or dotenv files.');
      }
      if (stat.isDirectory()) checkFiles(file);
      else if (!stat.isFile()) throw new Error('FieldOps export contains a non-file object.');
    }
  }
  checkFiles(exportDir);
}

function clearFieldopsOutput({ cwd, fsImpl = fs }) {
  cwd = path.resolve(cwd);
  for (const parts of [['apps', 'console', 'public', 'fieldops'], ['public', 'fieldops']]) {
    let current = cwd;
    for (const part of parts) {
      current = path.join(current, part);
      if (!current.startsWith(`${cwd}${path.sep}`) ||
          (fsImpl.existsSync(current) && fsImpl.lstatSync(current).isSymbolicLink())) {
        throw new Error('FieldOps output must remain inside the owned workspace.');
      }
    }
  }
  for (const parts of [['apps', 'console', 'public', 'fieldops'], ['public', 'fieldops']]) {
    fsImpl.rmSync(path.join(cwd, ...parts), { recursive: true, force: true });
  }
}

function exportFieldopsDev({ cwd, env, spawnSyncImpl = spawnSync, fsImpl = fs }) {
  cwd = path.resolve(cwd);
  validateFieldopsDevConfig({ cwd, env, spawnSyncImpl });
  const exportDir = path.join(cwd, 'apps', 'console', 'public', 'fieldops');
  // This is generated output owned by this build, never a shared cache or source tree.
  clearFieldopsOutput({ cwd, fsImpl });
  const result = spawnSyncImpl(process.execPath, [
    path.join(cwd, 'scripts', 'ops', 'mobile', 'run-fieldops-expo.js'),
    'export', '--platform', 'web', '--output-dir', exportDir, '--max-workers', '1',
  ], {
    cwd,
    env: fieldopsBuildEnv(env),
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) throw new Error('FieldOps DEV web export failed.');
  validateFieldopsExport(exportDir, fsImpl);
  // The Next adapter consumes root public beside the existing root .next mirror.
  const rootPublicDir = path.join(cwd, 'public', 'fieldops');
  fsImpl.mkdirSync(path.dirname(rootPublicDir), { recursive: true });
  fsImpl.cpSync(exportDir, rootPublicDir, { recursive: true });
  validateFieldopsExport(rootPublicDir, fsImpl);
  return exportDir;
}

function retainFieldopsDevExport({ cwd, env, spawnSyncImpl = spawnSync, fsImpl = fs }) {
  if (!isFieldopsDevHosting({ env, workspace: '@masarx/console' })) {
    throw new Error('FieldOps export retention requires Console DEV hosting.');
  }
  const runId = String(env.GITHUB_RUN_ID || '');
  const attempt = String(env.GITHUB_RUN_ATTEMPT || '');
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(attempt) || !env.RUNNER_TEMP) {
    throw new Error('FieldOps export retention requires the current GitHub run and runner temp directory.');
  }
  cwd = fsImpl.realpathSync(cwd);
  const exportDir = path.join(cwd, '.vercel', 'output', 'static', 'fieldops');
  if (fsImpl.lstatSync(exportDir).isSymbolicLink() ||
      !fsImpl.realpathSync(exportDir).startsWith(`${cwd}${path.sep}`)) {
    throw new Error('FieldOps materialized export must remain inside the owned workspace.');
  }
  validateFieldopsExport(exportDir, fsImpl);
  const git = spawnSyncImpl('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  });
  const source = String(git.stdout || '').trim().split(/\r?\n/);
  if (git.error || git.status !== 0 || source.length !== 2 || source.some((sha) => !/^[a-f0-9]{40}$/.test(sha))) {
    throw new Error('FieldOps export source commit/tree could not be resolved.');
  }
  const tempRoot = fsImpl.realpathSync(env.RUNNER_TEMP);
  const parts = ['evidence', 'fieldops-dev-export', source[0], `${runId}-${attempt}`];
  let artifactDir = tempRoot;
  for (const part of parts) {
    artifactDir = path.join(artifactDir, part);
    if (fsImpl.existsSync(artifactDir) && fsImpl.lstatSync(artifactDir).isSymbolicLink()) {
      throw new Error('FieldOps artifact staging must remain inside the owned runner temp directory.');
    }
  }
  if (fsImpl.existsSync(artifactDir)) throw new Error('FieldOps artifact staging already exists; preserve the prior receipt.');
  const inventory = (root, relative = '') => fsImpl.readdirSync(path.join(root, relative)).sort().flatMap((name) => {
    const file = path.join(relative, name);
    const fullPath = path.join(root, file);
    if (fsImpl.lstatSync(fullPath).isDirectory()) return inventory(root, file);
    const bytes = fsImpl.readFileSync(fullPath);
    return [{ path: file.split(path.sep).join('/'), bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  });
  const files = inventory(exportDir);
  fsImpl.mkdirSync(path.dirname(artifactDir), { recursive: true, mode: 0o700 });
  // Publish the upload path only after copy/validation/receipt all succeed.
  const stagingDir = fsImpl.mkdtempSync(path.join(path.dirname(artifactDir), '.fieldops-capture-'));
  const retainedDir = path.join(stagingDir, 'fieldops');
  fsImpl.cpSync(exportDir, retainedDir, { recursive: true, errorOnExist: true, force: false });
  validateFieldopsExport(retainedDir, fsImpl);
  if (JSON.stringify(inventory(retainedDir)) !== JSON.stringify(files) ||
      JSON.stringify(inventory(exportDir)) !== JSON.stringify(files)) {
    throw new Error('FieldOps retained export differs from the materialized prebuilt files.');
  }
  const archiveName = 'fieldops-web-export.tar.gz';
  const archiveResult = spawnSyncImpl('tar', ['-czf', archiveName, 'fieldops'], {
    cwd: stagingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
  if (archiveResult.error || archiveResult.status !== 0) throw new Error('FieldOps public export archive could not be created.');
  const archiveBytes = fsImpl.readFileSync(path.join(stagingDir, archiveName));
  const archive = { file: archiveName, bytes: archiveBytes.length,
    sha256: crypto.createHash('sha256').update(archiveBytes).digest('hex') };
  const publicEnv = fieldopsBuildEnv(env);
  const manifest = {
    schema_version: 1,
    app: 'console', stage: 'dev', base_path: FIELDOPS_BASE_PATH, build_mode: 'prebuilt',
    phase: 'materialized_before_publish',
    source: { sha: source[0], tree: source[1] },
    workflow: { run_id: runId, run_attempt: attempt, job: env.GITHUB_JOB || '',
      workflow_sha: env.GITHUB_WORKFLOW_SHA || '', event_sha: env.GITHUB_SHA || '' },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch,
      vercel_cli_version: env.VERCEL_CLI_VERSION || '' },
    configuration: { source: 'github_environment', environment: env.TARGET_DEPLOY_ENV || '',
      public_input_names: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
      public_inputs_present: Boolean(publicEnv.NEXT_PUBLIC_SUPABASE_URL && publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      values_included: false },
    archive,
    export: { root: 'fieldops', file_count: files.length,
      total_bytes: files.reduce((sum, file) => sum + file.bytes, 0), files },
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  fsImpl.writeFileSync(path.join(stagingDir, 'manifest.json'), text, { flag: 'wx', mode: 0o600 });
  fsImpl.renameSync(stagingDir, artifactDir);
  return { artifact_dir: artifactDir,
    manifest_sha256: crypto.createHash('sha256').update(text).digest('hex'),
    archive_sha256: archive.sha256, file_count: manifest.export.file_count, total_bytes: manifest.export.total_bytes };
}

module.exports = { retainFieldopsDevExport, FIELDOPS_BASE_PATH, isFieldopsDevHosting, validateFieldopsDevConfig, validateFieldopsExport, clearFieldopsOutput, exportFieldopsDev };
