#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');
const ts = require('typescript');
const { parse: parseToml } = require('smol-toml');

const OFFLINE_EDGE_CACHE_SOURCE_FILES = [
  'label-renderer/index.ts',
  '_shared/db-hotpath.ts',
  'label-designer-assets/index.ts',
  'api-caller/index.ts',
  'organization-profile/index.ts',
];
const EDGE_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const EDGE_DENO_CONFIGS = new Set(['deno.json', 'deno.jsonc']);
const EXCELJS_VENDOR_DIRECTORY = 'resource-import-studio/_vendor';
const EDGE_CACHE_RECEIPT_SCHEMA = 'masarx.edge-runtime-cache-materialization.v1';
const EDGE_RUNTIME_IMAGE_PATTERN = /^public\.ecr\.aws\/supabase\/edge-runtime:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/;
const DOCKER_PROXY_FIELDS = [
  ['HTTP_PROXY', 'HTTPProxy'],
  ['HTTPS_PROXY', 'HTTPSProxy'],
  ['NO_PROXY', 'NoProxy'],
];

function parseNpmSpecifier(specifier) {
  const value = String(specifier || '').trim().replace(/^npm:/, '');
  if (!value) return { packageName: '', requestedVersion: '' };

  let packageName = '';
  if (value.startsWith('@')) {
    const slash = value.indexOf('/');
    if (slash < 2) return { packageName: '', requestedVersion: '' };
    const versionMarker = value.indexOf('@', slash);
    const packageEnd = versionMarker === -1 ? value.indexOf('/', slash + 1) : versionMarker;
    packageName = value.slice(0, packageEnd === -1 ? value.length : packageEnd);
  } else {
    const versionMarker = value.indexOf('@');
    const subpathMarker = value.indexOf('/');
    const endings = [versionMarker, subpathMarker].filter((index) => index >= 0);
    packageName = value.slice(0, endings.length > 0 ? Math.min(...endings) : value.length);
  }

  const remainder = value.slice(packageName.length);
  const requestedVersion = remainder.startsWith('@') ? remainder.slice(1).split('/')[0] : '';
  return { packageName, requestedVersion };
}

function packageNameFromSpecifier(specifier) {
  return parseNpmSpecifier(specifier).packageName;
}

function compareBytewise(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function discoverEdgeFiles(functionsRoot) {
  const sourceFiles = [];
  const configFiles = [];
  const walk = (directory, prefix = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        if (relativePath !== EXCELJS_VENDOR_DIRECTORY) walk(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && EDGE_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        sourceFiles.push(relativePath);
      } else if (entry.isFile() && EDGE_DENO_CONFIGS.has(entry.name)) {
        configFiles.push(relativePath);
      }
    }
  };
  walk(functionsRoot);
  return { sourceFiles: sourceFiles.sort(compareBytewise), configFiles: configFiles.sort(compareBytewise) };
}

function discoverEdgeSourceFiles(functionsRoot) {
  return discoverEdgeFiles(functionsRoot).sourceFiles;
}

function verifyNoEdgeImportMaps(functionsRoot, configFiles) {
  for (const file of configFiles) {
    const { config, error } = ts.parseConfigFileTextToJson(file, fs.readFileSync(path.join(functionsRoot, file), 'utf8'));
    if (error || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`${file}: invalid Deno configuration`);
    }
    for (const key of ['imports', 'importMap', 'scopes']) {
      if (Object.hasOwn(config, key)) throw new Error(`${file}: ${key} is forbidden in Edge configuration`);
    }
  }

  let config;
  try {
    config = parseToml(fs.readFileSync(path.join(functionsRoot, '..', 'config.toml'), 'utf8'));
  } catch {
    throw new Error('supabase/config.toml: must be readable and valid TOML');
  }
  if (Object.hasOwn(config, 'import_map')
    || Object.values(config.functions ?? {}).some((fn) => Object.hasOwn(fn, 'import_map'))) {
    throw new Error('supabase/config.toml: import_map is forbidden in Edge configuration');
  }
}

function resolveSourceFiles(functionsRoot, sourceFiles = OFFLINE_EDGE_CACHE_SOURCE_FILES) {
  return sourceFiles.map((relativePath) => {
    const filePath = path.join(functionsRoot, relativePath);
    if (!fs.statSync(filePath).isFile()) {
      throw new Error('Edge dependency root is not a file: ' + relativePath);
    }
    return filePath;
  });
}

function collectModuleSpecifiers(functionsRoot, sourceFiles) {
  const imports = [];
  for (const filePath of resolveSourceFiles(functionsRoot, sourceFiles)) {
    const file = path.relative(functionsRoot, filePath).replace(/\\/g, '/');
    const source = ts.createSourceFile(file, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest);
    if (source.parseDiagnostics.length) throw new Error(`${file}: cannot parse Edge source`);

    const record = (literal) => {
      if (!literal || !ts.isStringLiteralLike(literal)) {
        throw new Error(`${file}: module specifiers must be string literals`);
      }
      const specifier = literal.text;
      if (specifier.startsWith('jsr:')) throw new Error(`${file}: JSR imports are forbidden`);
      if (!/^(?:npm:|node:|https?:\/\/|\.{1,2}\/)/.test(specifier)) {
        throw new Error(`${file}: bare or unsupported module specifier; use a relative path or an explicit npm:, node:, or remote URL import`);
      }
      imports.push({ file, specifier });
    };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        record(node.moduleSpecifier);
      } else if (ts.isExternalModuleReference(node)) {
        record(node.expression);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        record(node.argument.literal);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        record(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return imports;
}

function collectNpmImports(functionsRoot, sourceFiles) {
  return collectModuleSpecifiers(functionsRoot, sourceFiles)
    .filter(({ specifier }) => specifier.startsWith('npm:'))
    .map((entry) => ({ ...entry, ...parseNpmSpecifier(entry.specifier) }));
}

function collectExternalSpecifiers(functionsRoot, sourceFiles) {
  const specifiers = new Set(collectModuleSpecifiers(functionsRoot, sourceFiles)
    .map(({ specifier }) => specifier)
    .filter((specifier) => /^(?:npm:|https?:\/\/)/.test(specifier)));
  return [...specifiers].sort((left, right) => {
    const leftGroup = left.startsWith('npm:') ? 0 : 1;
    const rightGroup = right.startsWith('npm:') ? 0 : 1;
    return leftGroup - rightGroup || left.localeCompare(right);
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildEdgeRuntimeCacheContract({ functionsRoot, lockPath, denoLockPath, sourceFiles }) {
  const lockBytes = fs.readFileSync(lockPath);
  const denoLockBytes = fs.readFileSync(denoLockPath);
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const denoLock = JSON.parse(denoLockBytes.toString('utf8'));
  const specifiers = collectExternalSpecifiers(functionsRoot, sourceFiles);
  const npmRoots = specifiers
    .filter((specifier) => specifier.startsWith('npm:'))
    .map((specifier) => {
      const { packageName, requestedVersion } = parseNpmSpecifier(specifier);
      const entry = lock?.packages?.[`node_modules/${packageName}`] || {};
      return {
        specifier,
        package_name: packageName,
        version: requestedVersion,
        resolved: String(entry.resolved || ''),
        integrity: String(entry.integrity || ''),
      };
    });
  const remoteRoots = specifiers.filter((specifier) => /^https?:\/\//.test(specifier));
  const missingRemoteRoots = remoteRoots.filter((specifier) => !denoLock?.remote?.[specifier]);
  const syntheticSource = specifiers.map((specifier) => `import ${JSON.stringify(specifier)};`).join('\n') + '\n';
  const selectedSources = sourceFiles || OFFLINE_EDGE_CACHE_SOURCE_FILES;
  const vendoredArtifacts = selectedSources.includes('resource-import-studio/index.ts')
    ? [require('./prepare-resource-import-exceljs').readArtifact(path.resolve(functionsRoot, '..', '..'))] : [];

  const contract = {
    schema: 'masarx.edge-runtime-cache-contract.v1',
    mode: 'trusted_synthetic_import_only',
    dependency_inputs: {
      package_lock_sha256: crypto.createHash('sha256').update(lockBytes).digest('hex'),
      deno_lock_sha256: crypto.createHash('sha256').update(denoLockBytes).digest('hex'),
    },
    specifiers,
    npm_roots: npmRoots,
    vendored_artifacts: vendoredArtifacts,
    remote_roots: remoteRoots.map((specifier) => ({ specifier, sha256: denoLock?.remote?.[specifier] || '' })),
    missing_remote_roots: missingRemoteRoots,
    synthetic_source: syntheticSource,
    synthetic_source_sha256: crypto.createHash('sha256').update(syntheticSource).digest('hex'),
  };
  return {
    ...contract,
    contract_sha256: crypto.createHash('sha256').update(stableJson(contract)).digest('hex'),
  };
}

function assertEdgeRuntimeCacheLockContract({ functionsRoot, lockPath, denoLockPath, sourceFiles }) {
  const verification = verifyNpmImportsInLock({
    functionsRoot,
    lockPath,
    denoLockPath,
    sourceFiles,
  });
  const contract = buildEdgeRuntimeCacheContract({
    functionsRoot,
    lockPath,
    denoLockPath,
    sourceFiles,
  });
  const failures = [
    ['missing_package_lock', verification.missing.length],
    ['missing_deno_lock', verification.missingFromDenoLock.length],
    ['version_mismatch', verification.versionMismatches.length],
    ['missing_integrity', verification.missingIntegrity.length],
    ['missing_remote_lock', contract.missing_remote_roots.length],
  ].filter(([, count]) => count > 0);
  if (failures.length) {
    throw new Error(
      `Edge runtime cache lock verification failed (${failures
        .map(([label, count]) => `${label}=${count}`)
        .join(', ')}).`,
    );
  }
  return { contract, verification };
}

function redactProxyValues(value, env = {}) {
  let redacted = String(value || '');
  for (const [envName] of DOCKER_PROXY_FIELDS) {
    for (const candidate of [env[envName], env[envName.toLowerCase()]]) {
      const proxyValue = String(candidate || '').trim();
      if (proxyValue) redacted = redacted.split(proxyValue).join('[REDACTED]');
    }
  }
  return redacted;
}

function runOwnedEdgeCacheContainer(command, runArgs, options, fsImpl = fs) {
  if (command !== 'docker' || runArgs[0] !== 'run' || runArgs[1] !== '--rm') throw new Error('Invalid cache container command');
  const nonce = crypto.randomBytes(16).toString('hex');
  const name = `masarx-edge-cache-${nonce}`;
  const label = 'com.masarx.edge-cache.invocation';
  const custody = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'masarx-edge-cache-command-'));
  const receiptPath = path.join(custody, 'custody.json');
  const args = runArgs.slice(2);
  const imageIndex = args.findIndex(value => EDGE_RUNTIME_IMAGE_PATTERN.test(value));
  if (imageIndex < 0) throw new Error('Cache container exact image missing');
  const image = args[imageIndex];
  const mounts = args.flatMap((value, index) => value === '--mount' ? [args[index + 1]] : []).map(value => {
    const fields = Object.fromEntries(value.split(',').map(part => part.split('=')));
    return { Type: fields.type, Source: fields.src, Destination: fields.dst, RW: !value.split(',').includes('readonly') };
  }).sort((a, b) => a.Destination.localeCompare(b.Destination));
  const entryIndex = args.slice(0, imageIndex).indexOf('--entrypoint');
  const expectedEntrypoint = entryIndex < 0 ? null : [args[entryIndex + 1]];
  const dockerArgs = args.slice(0, imageIndex);
  const valueOf = flag => dockerArgs[dockerArgs.indexOf(flag) + 1];
  const valuesOf = flag => dockerArgs.flatMap((value, index) => value === flag ? [dockerArgs[index + 1]] : []);
  const sorted = value => [...(value || [])].sort();
  const state = { name, nonce, image, mounts, id: null, phase: 'before-create' };
  const persist = () => fsImpl.writeFileSync(receiptPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  const spawn = options.spawnSyncImpl;
  const control = (argv) => spawn('docker', argv, { ...options, timeout: 60000 });
  let attempted = false;
  let removed = false;
  let identity;
  const inspect = () => {
    const result = control(['container', 'inspect', state.id]);
    if (result.error || result.signal || result.status !== 0) throw new Error('Cache container inspection unavailable');
    let rows;
    try { rows = JSON.parse(String(result.stdout)); }
    catch { throw new Error('Cache container inspection returned invalid JSON'); }
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Cache container inspection ambiguous');
    const row = rows[0];
    const actualMounts = (row.Mounts || []).map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW }))
      .sort((a, b) => a.Destination.localeCompare(b.Destination));
    if (row.Id !== state.id || row.Name !== '/' + name || row.Config?.Labels?.[label] !== nonce
      || row.Config?.Image !== image || JSON.stringify(actualMounts) !== JSON.stringify(mounts)
      || JSON.stringify(row.Config?.Cmd) !== JSON.stringify(args.slice(imageIndex + 1))
      || (expectedEntrypoint && JSON.stringify(row.Config?.Entrypoint) !== JSON.stringify(expectedEntrypoint))) {
      throw new Error('Cache container ownership identity mismatch');
    }
    const config = row.Config;
    const host = row.HostConfig || {};
    if (config.User !== valueOf('--user') || host.NetworkMode !== valueOf('--network')
      || host.ReadonlyRootfs !== true || host.Privileged !== false
      || sorted(host.CapAdd).length !== 0 || JSON.stringify(sorted(host.CapDrop)) !== JSON.stringify(sorted(valuesOf('--cap-drop')))
      || JSON.stringify(sorted(host.SecurityOpt)) !== JSON.stringify(sorted(valuesOf('--security-opt')))
      || (dockerArgs.includes('--memory') && host.Memory !== Number(valueOf('--memory')))
      || (dockerArgs.includes('--memory-swap') && host.MemorySwap !== Number(valueOf('--memory-swap')))
      || (dockerArgs.includes('--cpus') && host.NanoCpus !== Number(valueOf('--cpus')) * 1e9)
      || (dockerArgs.includes('--pids-limit') && host.PidsLimit !== Number(valueOf('--pids-limit')))
      || !Array.isArray(config.Env) || !config.Env.every(value => typeof value === 'string')) {
      throw new Error('Cache container security contract mismatch');
    }
    // Exclude daemon-populated bookkeeping, never ownership, environment or execution controls.
    const projection = {
      id: row.Id, created: row.Created, image_id: row.Image, image: config.Image,
      name: row.Name, labels: Object.fromEntries(Object.entries(config.Labels).sort()),
      user: config.User, command: config.Cmd, entrypoint: config.Entrypoint,
      env_sha256: crypto.createHash('sha256').update(JSON.stringify(config.Env)).digest('hex'),
      mounts: actualMounts, network: host.NetworkMode, readonly: host.ReadonlyRootfs,
      privileged: host.Privileged, cap_add: sorted(host.CapAdd), cap_drop: sorted(host.CapDrop),
      security_opt: sorted(host.SecurityOpt), memory: host.Memory, memory_swap: host.MemorySwap,
      nano_cpus: host.NanoCpus, pids_limit: host.PidsLimit,
      devices: host.Devices, device_requests: host.DeviceRequests, binds: host.Binds,
      port_bindings: host.PortBindings, publish_all_ports: host.PublishAllPorts,
      pid_mode: host.PidMode, ipc_mode: host.IpcMode, uts_mode: host.UTSMode,
      userns_mode: host.UsernsMode, cgroupns_mode: host.CgroupnsMode,
      restart_policy: host.RestartPolicy, auto_remove: host.AutoRemove,
    };
    const currentIdentity = JSON.stringify(projection);
    if (identity && identity !== currentIdentity) throw new Error('Cache container identity changed');
    identity = currentIdentity;
    if (!state.identity_projection) {
      state.identity_projection = projection;
      state.identity_sha256 = crypto.createHash('sha256').update(currentIdentity).digest('hex');
      persist();
    }
    return row.State;
  };
  try {
    persist();
    attempted = true;
    const created = control(['create', '--name', name, '--label', `${label}=${nonce}`, ...args]);
    if (created.error || created.signal || created.status !== 0) throw new Error('Cache container creation unsettled');
    state.id = String(created.stdout || '').trim();
    if (!/^[0-9a-f]{64}$/.test(state.id)) throw new Error('Cache container ID invalid');
    state.phase = 'created'; persist();
    const before = inspect();
    if (before?.Status !== 'created' || before.Running !== false || before.Restarting !== false) throw new Error('Cache container not safely created');
    state.phase = 'starting'; persist();
    const result = spawn('docker', ['start', '--attach', state.id], options);
    if (result.error || result.signal || !Number.isInteger(result.status)) throw new Error('Cache container execution unsettled');
    const after = inspect();
    if (after?.Status !== 'exited' || after.Running !== false || after.Restarting !== false || after.ExitCode !== result.status) {
      throw new Error('Cache container terminal state unproven');
    }
    state.phase = 'terminal'; persist();
    const removal = control(['container', 'rm', state.id]);
    if (removal.error || removal.signal || removal.status !== 0 || String(removal.stdout || '').trim() !== state.id) throw new Error('Cache container removal unproven');
    const absent = control(['container', 'inspect', state.id]);
    if (absent.error || absent.signal || absent.status !== 1
      || !String(absent.stderr || '').includes(`No such container: ${state.id}`)) throw new Error('Cache container absence unproven');
    removed = true;
    return result;
  } catch (error) {
    error.code = 'EDGE_CACHE_CONTAINER_UNSETTLED';
    error.preserveEdgeCacheStaging = attempted && !removed;
    error.message = `${error.message}; preserve cache custody ${receiptPath}`;
    throw error;
  } finally {
    if (!attempted || removed) fsImpl.rmSync(custody, { recursive: true, force: true });
  }
}

function attestEdgeRuntimeCache({ cacheDir, image, env, fsImpl, spawnSyncImpl }) {
  const { uid, gid } = fsImpl.statSync(cacheDir);
  const attest = runOwnedEdgeCacheContainer(
    'docker',
    [
      'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'sh',
      '--user', `${uid}:${gid}`,
      '--mount', `type=bind,src=${cacheDir},dst=/cache,readonly`,
      image, '-ceu', [
        'test -n "$(find /cache -mindepth 1 -print -quit)"',
        'test "$(find /cache -xdev -type l | wc -l | tr -d " ")" = "0"',
        'sha=$(tar --sort=name --mtime="UTC 1970-01-01" --owner=0 --group=0 --numeric-owner -C /cache -cf - . | sha256sum | awk "{print \\$1}")',
        'files=$(find /cache -xdev -type f | wc -l | tr -d " ")',
        'bytes=$(find /cache -xdev -type f -printf "%s\\n" | awk "{sum+=\\$1} END {print sum+0}")',
        'printf "%s\\t%s\\t%s\\n" "$sha" "$files" "$bytes"',
      ].join('; '),
    ],
    { encoding: 'utf8', env, timeout: 60000, spawnSyncImpl }, fsImpl,
  );
  if (attest?.error || attest?.status !== 0) {
    const errorMessage = redactProxyValues(attest?.error?.message, env);
    const stderr = redactProxyValues(attest?.stderr, env);
    throw new Error(`Edge runtime cache attestation failed: ${errorMessage || stderr || attest?.status}`);
  }
  const [sha256, fileCount, bytes] = String(attest.stdout || '').trim().split('\t');
  if (!/^[0-9a-f]{64}$/.test(sha256) || !/^[1-9]\d*$/.test(fileCount) || !/^[1-9]\d*$/.test(bytes)) {
    throw new Error('Edge runtime cache attestation returned an invalid receipt.');
  }
  return { sha256, fileCount, bytes };
}

function buildEdgeCacheReceipt(contract, image, attestation) {
  return {
    schema: EDGE_CACHE_RECEIPT_SCHEMA,
    contract_sha256: contract.contract_sha256,
    image,
    dependency_inputs: contract.dependency_inputs,
    synthetic_source_sha256: contract.synthetic_source_sha256,
    specifier_count: contract.specifiers.length,
    npm_root_count: contract.npm_roots.length,
    remote_root_count: contract.remote_roots.length,
    cache: {
      sha256: attestation.sha256,
      file_count: attestation.fileCount,
      bytes: attestation.bytes,
    },
  };
}

function edgeCacheEnv(cacheDir, image, attestation) {
  return {
    WORKSPACE_LOCAL_EDGE_CACHE_DIR: cacheDir,
    WORKSPACE_LOCAL_EDGE_CACHE_SHA256: attestation.sha256,
    WORKSPACE_LOCAL_EDGE_CACHE_FILE_COUNT: attestation.fileCount,
    WORKSPACE_LOCAL_EDGE_CACHE_BYTES: attestation.bytes,
    WORKSPACE_LOCAL_EDGE_CACHE_IMAGE: image,
  };
}

function resolveDockerProxyEnv(runtimeEnv, spawnSyncImpl) {
  const dockerEnv = { ...runtimeEnv };
  const missing = [];
  for (const [envName, infoField] of DOCKER_PROXY_FIELDS) {
    const upperValue = String(runtimeEnv[envName] || '').trim();
    const lowerValue = String(runtimeEnv[envName.toLowerCase()] || '').trim();
    if (upperValue) dockerEnv[envName] = upperValue;
    else if (lowerValue) dockerEnv[envName] = lowerValue;
    else missing.push([envName, infoField]);
  }
  if (missing.length === 0) return dockerEnv;

  const info = spawnSyncImpl(
    'docker',
    [
      'info', '--format',
      '{"HTTPProxy":{{json .HTTPProxy}},"HTTPSProxy":{{json .HTTPSProxy}},"NoProxy":{{json .NoProxy}}}',
    ],
    { encoding: 'utf8', env: runtimeEnv },
  );
  if (info?.error || info?.status !== 0) {
    throw new Error(`Docker daemon proxy discovery failed: ${redactProxyValues(info?.error?.message, runtimeEnv) || info?.status}`);
  }
  let daemonInfo;
  try {
    daemonInfo = JSON.parse(String(info.stdout || ''));
  } catch {
    throw new Error('Docker daemon proxy discovery returned invalid JSON.');
  }
  for (const [envName, infoField] of missing) {
    const value = String(daemonInfo?.[infoField] || '').trim();
    if (value) dockerEnv[envName] = value;
  }
  return dockerEnv;
}

function resolveEdgeRuntimeCacheImage(repoRoot, runtimeEnv, fsImpl, options = {}) {
  const cliVersion = String(runtimeEnv.SUPABASE_CLI_VERSION || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(cliVersion)) {
    throw new Error('Edge runtime cache requires an exact SUPABASE_CLI_VERSION.');
  }
  const contractPath = path.resolve(
    options.cliContractPath || path.join(repoRoot, 'config', 'ci', 'deploy-cli-contract.json'),
  );
  let contract;
  try {
    contract = JSON.parse(fsImpl.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(`Edge runtime cache CLI contract is unreadable: ${error.message}`);
  }
  const supabase = Array.isArray(contract?.tools)
    ? contract.tools.find((tool) => tool?.tool_id === 'supabase')
    : null;
  const image = String(
    supabase?.local_runtime_images_by_version?.[cliVersion]?.edge_runtime || '',
  ).trim();
  if (!EDGE_RUNTIME_IMAGE_PATTERN.test(image)) {
    throw new Error(`Edge runtime cache has no exact image contract for Supabase CLI ${cliVersion}.`);
  }
  return image;
}

function materializeEdgeRuntimeCache(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  const functionsRoot = path.join(repoRoot, 'supabase', 'functions');
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const denoLockPath = path.join(repoRoot, 'deno.lock');
  const fsImpl = options.fsImpl || fs;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const runtimeEnv = options.env || process.env;
  const { contract } = assertEdgeRuntimeCacheLockContract({
    functionsRoot, lockPath, denoLockPath, sourceFiles: options.sourceFiles,
  });
  const expectedImage = resolveEdgeRuntimeCacheImage(repoRoot, runtimeEnv, fsImpl, options);

  const imageList = spawnSyncImpl(
    'docker',
    [
      'image', 'ls',
      '--filter', 'reference=public.ecr.aws/supabase/edge-runtime:*',
      '--format', '{{.Repository}}:{{.Tag}}@{{.Digest}}',
    ],
    { encoding: 'utf8', env: runtimeEnv },
  );
  if (imageList?.error || imageList?.status !== 0) {
    const errorMessage = redactProxyValues(imageList?.error?.message, runtimeEnv);
    const stderr = redactProxyValues(imageList?.stderr, runtimeEnv);
    throw new Error(`Edge runtime cache image discovery failed: ${errorMessage || stderr || imageList?.status}`);
  }
  const images = [...new Set(String(imageList.stdout || '').split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => EDGE_RUNTIME_IMAGE_PATTERN.test(value)))];
  const matchingImages = images.filter((image) => image === expectedImage);
  if (matchingImages.length !== 1) {
    throw new Error(
      `Edge runtime cache requires its exact configured image; found ${matchingImages.length} matches among ${images.length} cached pins.`,
    );
  }
  const [image] = matchingImages;

  const cacheRoot = path.resolve(
    options.cacheRoot
      || path.join(options.env?.RUNNER_TEMP || os.tmpdir(), 'masarx-edge-runtime-cache', contract.contract_sha256),
  );
  const publishedCacheDir = path.join(cacheRoot, 'deno');
  const receiptPath = path.join(cacheRoot, 'materialization-receipt.json');
  if (fsImpl.existsSync(cacheRoot)) {
    if (!fsImpl.existsSync(receiptPath) || !fsImpl.existsSync(publishedCacheDir)) {
      throw new Error('Edge runtime cache reuse refused a directory without a complete materialization receipt.');
    }
    let receipt;
    try {
      receipt = JSON.parse(fsImpl.readFileSync(receiptPath, 'utf8'));
    } catch (error) {
      throw new Error(`Edge runtime cache materialization receipt is unreadable: ${error.message}`);
    }
    const attestation = attestEdgeRuntimeCache({
      cacheDir: publishedCacheDir,
      image,
      env: runtimeEnv,
      fsImpl,
      spawnSyncImpl,
    });
    const expectedReceipt = buildEdgeCacheReceipt(contract, image, attestation);
    if (stableJson(receipt) !== stableJson(expectedReceipt)) {
      throw new Error('Edge runtime cache materialization receipt does not match the exact cache contract.');
    }
    return { contract, receipt, env: edgeCacheEnv(publishedCacheDir, image, attestation) };
  }

  const dockerEnv = resolveDockerProxyEnv(runtimeEnv, spawnSyncImpl);
  const proxyArgs = DOCKER_PROXY_FIELDS
    .filter(([envName]) => String(dockerEnv[envName] || '').trim())
    .flatMap(([envName]) => ['--env', envName]);
  fsImpl.mkdirSync(path.dirname(cacheRoot), { recursive: true });
  const stagingRoot = fsImpl.mkdtempSync(`${cacheRoot}.tmp-`);
  const inputRoot = path.join(stagingRoot, '.input');
  const cacheDir = path.join(stagingRoot, 'deno');
  const sourcePath = path.join(inputRoot, 'index.ts');
  const bundlePath = path.join(inputRoot, 'bundle.eszip');
  fsImpl.mkdirSync(inputRoot, { recursive: true });
  fsImpl.mkdirSync(cacheDir, { recursive: true });
  fsImpl.writeFileSync(sourcePath, contract.synthetic_source, { encoding: 'utf8', mode: 0o600 });
  const { uid, gid } = fsImpl.statSync(stagingRoot);

  let published = false;
  let preserveStaging = false;
  try {
    const bundle = runOwnedEdgeCacheContainer(
      'docker',
      [
        'run', '--rm', '--pull', 'never', '--network', 'bridge', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
        '--memory', '2147483648', '--memory-swap', '2147483648', '--cpus', '2',
        '--user', `${uid}:${gid}`, '--env', 'DENO_DIR=/cache', ...proxyArgs,
        '--mount', `type=bind,src=${sourcePath},dst=/input/index.ts,readonly`,
        '--mount', `type=bind,src=${cacheDir},dst=/cache`,
        '--mount', `type=bind,src=${inputRoot},dst=/output`,
        image,
        'bundle', '--entrypoint', '/input/index.ts', '--output', '/output/bundle.eszip', '--timeout', '600',
      ],
      { encoding: 'utf8', env: dockerEnv, timeout: 660000, spawnSyncImpl }, fsImpl,
    );
    if (bundle?.error || bundle?.status !== 0) {
      const errorMessage = redactProxyValues(bundle?.error?.message, dockerEnv);
      const stderr = redactProxyValues(bundle?.stderr, dockerEnv);
      throw new Error(`Edge runtime cache materialization failed: ${errorMessage || stderr || bundle?.status}`);
    }

    const attestation = attestEdgeRuntimeCache({
      cacheDir,
      image,
      env: runtimeEnv,
      fsImpl,
      spawnSyncImpl,
    });
    if (fsImpl.existsSync(bundlePath)) fsImpl.rmSync(bundlePath, { force: true });
    fsImpl.rmSync(inputRoot, { recursive: true, force: true });
    const receipt = buildEdgeCacheReceipt(contract, image, attestation);
    fsImpl.writeFileSync(
      path.join(stagingRoot, 'materialization-receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    fsImpl.renameSync(stagingRoot, cacheRoot);
    published = true;
    return { contract, receipt, env: edgeCacheEnv(publishedCacheDir, image, attestation) };
  } catch (error) {
    preserveStaging = error.preserveEdgeCacheStaging === true;
    throw error;
  } finally {
    if (!published && !preserveStaging && fsImpl.existsSync(stagingRoot)) {
      fsImpl.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}

function verifyNpmImportsInLock({ functionsRoot, lockPath, denoLockPath, sourceFiles }) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const packages = lock && typeof lock.packages === 'object' && lock.packages ? lock.packages : {};
  const denoLock = JSON.parse(fs.readFileSync(denoLockPath, 'utf8'));
  const denoResolution = ({ packageName, requestedVersion }) =>
    denoLock.specifiers?.[`npm:${packageName}@${requestedVersion}`];
  const denoPackage = (entry) => denoLock.npm?.[`${entry.packageName}@${denoResolution(entry)}`];
  const imports = collectNpmImports(functionsRoot, sourceFiles ?? discoverEdgeSourceFiles(functionsRoot));
  const missing = imports.filter(({ packageName }) => !packages[`node_modules/${packageName}`]);
  const missingFromDenoLock = imports.filter((entry) => !denoPackage(entry));
  const versionMismatches = imports.flatMap((entry) => {
    const { packageName, requestedVersion } = entry;
    const lockedVersion = String(packages[`node_modules/${packageName}`]?.version || '').trim();
    // Deno appends peer dependency information to some resolutions.
    const resolution = denoResolution(entry);
    if (requestedVersion && requestedVersion === lockedVersion && (!resolution || resolution.split('_', 1)[0] === lockedVersion)) {
      return [];
    }
    return [{ ...entry, lockedVersion, resolution }];
  });
  const missingIntegrity = imports.filter((entry) => {
    const npm = packages[`node_modules/${entry.packageName}`];
    const deno = denoPackage(entry);
    return !String(npm?.resolved || '').startsWith('https://registry.npmjs.org/') ||
      !String(npm?.integrity || '').startsWith('sha512-') ||
      (deno && deno.integrity !== npm.integrity);
  });
  return { imports, missing, missingFromDenoLock, versionMismatches, missingIntegrity };
}

function verifyEdgeImportLock() {
  const repoRoot = path.join(__dirname, '..', '..');
  const functionsRoot = path.join(repoRoot, 'supabase', 'functions');
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const denoLockPath = path.join(repoRoot, 'deno.lock');
  const { sourceFiles, configFiles } = discoverEdgeFiles(functionsRoot);
  verifyNoEdgeImportMaps(functionsRoot, configFiles);
  const { imports, missing, missingFromDenoLock, versionMismatches, missingIntegrity } = verifyNpmImportsInLock({
    functionsRoot,
    lockPath,
    denoLockPath,
    sourceFiles,
  });
  if (missing.length > 0) {
    console.error('[edge:verify-npm-import-lock] Edge npm imports missing from package-lock.json:');
    for (const entry of missing) {
      console.error(`- ${entry.file}: ${entry.specifier}`);
    }
    process.exit(1);
  }

  if (versionMismatches.length > 0) {
    console.error('[edge:verify-npm-import-lock] Edge npm imports are not pinned to package-lock.json:');
    for (const entry of versionMismatches) {
      console.error(`- ${entry.file}: ${entry.specifier} (package-lock=${entry.lockedVersion}, deno.lock=${entry.resolution || 'missing'})`);
    }
    process.exit(1);
  }

  if (missingFromDenoLock.length > 0) {
    console.error('[edge:verify-npm-import-lock] Edge npm imports missing from deno.lock:');
    for (const entry of missingFromDenoLock) {
      console.error(`- ${entry.file}: ${entry.specifier}`);
    }
    process.exit(1);
  }

  if (missingIntegrity.length > 0) {
    console.error('[edge:verify-npm-import-lock] Edge npm imports lack matching registry integrity:');
    for (const entry of missingIntegrity) {
      console.error(`- ${entry.file}: ${entry.specifier}`);
    }
    process.exit(1);
  }

  const cacheContract = buildEdgeRuntimeCacheContract({ functionsRoot, lockPath, denoLockPath, sourceFiles });
  if (cacheContract.missing_remote_roots.length > 0) {
    console.error('[edge:verify-npm-import-lock] Edge remote imports are missing from deno.lock:');
    cacheContract.missing_remote_roots.forEach((specifier) => console.error(`- ${specifier}`));
    process.exit(1);
  }


  const packageCount = new Set(imports.map(({ packageName }) => packageName)).size;
  console.log(
    `[edge:verify-npm-import-lock] ${imports.length} imports across ${packageCount} packages are exact-version and integrity bound.`,
  );
  console.log(
    `[edge:verify-npm-import-lock] Offline cache contract binds ${cacheContract.specifiers.length} external roots (${cacheContract.synthetic_source_sha256}).`,
  );
}

if (require.main === module) {
  try {
    verifyEdgeImportLock();
  } catch (error) {
    console.error(`[edge:verify-npm-import-lock] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildEdgeRuntimeCacheContract,
  buildEdgeCacheReceipt,
  collectExternalSpecifiers,
  collectNpmImports,
  discoverEdgeSourceFiles,
  assertEdgeRuntimeCacheLockContract,
  materializeEdgeRuntimeCache,
  resolveEdgeRuntimeCacheImage,
  packageNameFromSpecifier,
  parseNpmSpecifier,
  verifyEdgeImportLock,
  verifyNpmImportsInLock,
};
