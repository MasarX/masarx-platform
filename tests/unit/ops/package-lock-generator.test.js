const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CI_ARGS,
  INSTALL_ARGS,
  LOCK_LS_ARGS,
  LS_ARGS,
  NPM_COMMAND_TIMEOUT_MS,
  assertExactRuntime,
  createNpmRunner,
  discoverWorkspaceManifestPaths,
  execute,
  npmEnvironment,
  parseArgs,
  parseRuntimeContract,
  resolveDirectLinuxProxyEnvironment,
  validatePackageLock,
} = require('../../../scripts/ops/ci/package-lock-generator');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

function manifest({ name, dependencies = {}, devDependencies = {} } = {}) {
  return { name, version: '1.0.0', dependencies, devDependencies };
}

function lockEntryFor(value) {
  const entry = { name: value.name, version: value.version };
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (value[section] && Object.keys(value[section]).length > 0) entry[section] = value[section];
  }
  return entry;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-generator-test-'));
  const rootManifest = {
    ...manifest({ name: 'fixture-root', dependencies: { alpha: '^1.0.0' } }),
    private: true,
    packageManager: 'npm@11.16.0',
    workspaces: ['packages/*', 'apps/*'],
  };
  const appManifest = manifest({ name: '@fixture/app', dependencies: { '@fixture/lib': '1.0.0' } });
  const packageManifest = manifest({ name: '@fixture/lib', devDependencies: { beta: '^2.0.0' } });
  writeJson(path.join(root, 'package.json'), rootManifest);
  writeJson(path.join(root, 'apps', 'app', 'package.json'), appManifest);
  writeJson(path.join(root, 'packages', 'lib', 'package.json'), packageManifest);
  fs.writeFileSync(path.join(root, '.nvmrc'), '24.18.0\n', 'utf8');
  const lock = {
    name: 'fixture-root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': lockEntryFor(rootManifest),
      'apps/app': lockEntryFor(appManifest),
      'packages/lib': lockEntryFor(packageManifest),
    },
  };
  writeJson(path.join(root, 'package-lock.json'), lock);
  return { root, rootManifest, lock };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function unchangedRunner(calls) {
  return ({ args, cwd }) => {
    calls.push({ args: [...args], cwd });
    if (args[0] === '--version') return '11.16.0';
    return '';
  };
}

describe('package-lock-generator', () => {
  test('requires exactly one known mode', () => {
    expect(parseArgs(['--write'])).toBe('write');
    expect(parseArgs(['--check'])).toBe('check');
    expect(() => parseArgs([])).toThrow('exactly one');
    expect(() => parseArgs(['--write', '--check'])).toThrow('exactly one');
    expect(() => parseArgs(['--verify'])).toThrow('unknown argument');
  });

  test('parses the exact runtime contract from repository files', () => {
    const { root } = createFixture();
    try {
      expect(parseRuntimeContract(root)).toMatchObject({ nodeVersion: '24.18.0', npmVersion: '11.16.0' });
    } finally {
      cleanup(root);
    }
  });

  test('rejects the wrong Node or npm version', () => {
    const { root } = createFixture();
    try {
      expect(() => assertExactRuntime({ repoRoot: root, nodeVersion: '24.17.0', npmRunner: () => '11.16.0' })).toThrow(
        'Node 24.18.0 is required',
      );
      expect(() => assertExactRuntime({ repoRoot: root, nodeVersion: '24.18.0', npmRunner: () => '11.15.0' })).toThrow(
        'npm 11.16.0 is required',
      );
    } finally {
      cleanup(root);
    }
  });

  test('discovers workspace manifests deterministically', () => {
    const { root, rootManifest } = createFixture();
    try {
      fs.mkdirSync(path.join(root, 'apps', 'shared'), { recursive: true });
      fs.writeFileSync(path.join(root, 'apps', 'shared', 'source.js'), 'module.exports = {};\n');
      expect(discoverWorkspaceManifestPaths(root, rootManifest)).toEqual([
        'apps/app/package.json',
        'packages/lib/package.json',
      ]);
    } finally {
      cleanup(root);
    }
  });

  test('rejects escaping, missing, and duplicate workspaces', () => {
    const { root, rootManifest } = createFixture();
    try {
      expect(() => discoverWorkspaceManifestPaths(root, { ...rootManifest, workspaces: ['../outside'] })).toThrow(
        'escapes the repository',
      );
      expect(() => discoverWorkspaceManifestPaths(root, { ...rootManifest, workspaces: ['apps/missing'] })).toThrow();
      expect(() => discoverWorkspaceManifestPaths(root, { ...rootManifest, workspaces: ['apps/*', 'apps/app'] })).toThrow(
        'duplicate workspace path',
      );
    } finally {
      cleanup(root);
    }
  });

  test('uses one canonical npm argv for generation and lock-tree validation', () => {
    const { root } = createFixture();
    const calls = [];
    try {
      execute({ mode: 'write', repoRoot: root, nodeVersion: '24.18.0', npmRunner: unchangedRunner(calls) });
      expect(calls.map((call) => call.args)).toEqual([
        ['--version'],
        INSTALL_ARGS,
        INSTALL_ARGS,
        INSTALL_ARGS,
        LOCK_LS_ARGS,
        CI_ARGS,
        LS_ARGS,
      ]);
    } finally {
      cleanup(root);
    }
  });

  test('hydrates only missing standard proxy aliases from a direct Linux login environment', () => {
    const spawnSyncImpl = jest.fn(() => ({
      status: 0,
      stdout: [
        'HTTP_PROXY=http://login-proxy.test:3128',
        'http_proxy=http://login-proxy.test:3128',
        'HTTPS_PROXY=http://login-proxy.test:3128',
        'https_proxy=http://login-proxy.test:3128',
        'NO_PROXY=localhost,127.0.0.1',
        'no_proxy=localhost,127.0.0.1',
        'NPM_CONFIG_REGISTRY=https://untrusted.example.test',
        'UNRELATED=ignored',
      ].join('\n'),
      stderr: '',
    }));

    const resolved = resolveDirectLinuxProxyEnvironment({
      env: { PATH: '/trusted/bin', HTTP_PROXY: 'http://explicit.test:8080' },
      platform: 'linux',
      spawnSyncImpl,
    });

    expect(resolved).toMatchObject({
      PATH: '/trusted/bin',
      HTTP_PROXY: 'http://explicit.test:8080',
      HTTPS_PROXY: 'http://login-proxy.test:3128',
      https_proxy: 'http://login-proxy.test:3128',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    });
    expect(resolved).not.toHaveProperty('http_proxy');
    expect(resolved).not.toHaveProperty('NPM_CONFIG_REGISTRY');
    expect(resolved).not.toHaveProperty('UNRELATED');
    expect(spawnSyncImpl).toHaveBeenCalledWith('/bin/bash', ['-lc', 'env'], expect.objectContaining({
      env: { PATH: '/trusted/bin', HTTP_PROXY: 'http://explicit.test:8080' },
      shell: false,
    }));
  });

  test.each([
    ['GitHub Linux', { GITHUB_ACTIONS: 'true' }, 'linux'],
    ['non-Linux', { PATH: '/trusted/bin' }, 'win32'],
  ])('does not probe the login environment on %s', (_label, env, platform) => {
    const spawnSyncImpl = jest.fn();
    expect(resolveDirectLinuxProxyEnvironment({ env, platform, spawnSyncImpl })).toEqual(env);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  test('falls back to the explicit environment when the login probe fails', () => {
    const env = { PATH: '/trusted/bin' };
    expect(resolveDirectLinuxProxyEnvironment({
      env,
      platform: 'linux',
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'denied' }),
    })).toEqual(env);
  });

  test('write mode propagates generation and npm-ls failures', () => {
    const { root } = createFixture();
    try {
      expect(() =>
        execute({
          mode: 'write',
          repoRoot: root,
          nodeVersion: '24.18.0',
          npmRunner: ({ args }) => {
            if (args[0] === '--version') return '11.16.0';
            if (args[0] === 'install') throw new Error('install failed');
            return '';
          },
        }),
      ).toThrow('install failed');
      expect(() =>
        execute({
          mode: 'write',
          repoRoot: root,
          nodeVersion: '24.18.0',
          npmRunner: ({ args }) => {
            if (args[0] === '--version') return '11.16.0';
            if (args[0] === 'ls') throw new Error('tree failed');
            return '';
          },
        }),
      ).toThrow('tree failed');
    } finally {
      cleanup(root);
    }
  });

  test('pins bounded hoisted npm execution and disables bypass configuration', () => {
    const calls = [];
    const runner = createNpmRunner({
      npmCli: __filename,
      spawn: (_nodePath, _args, options) => {
        calls.push(options);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    runner({ args: ['--version'], cwd: __dirname, env: npmEnvironment({ NODE_ENV: 'production' }) });

    expect(calls[0].timeout).toBe(NPM_COMMAND_TIMEOUT_MS);
    expect(calls[0].shell).toBe(false);
    expect(calls[0].windowsHide).toBe(true);
    expect(calls[0].env).toMatchObject({
      NODE_ENV: 'development',
      npm_config_force: 'false',
      npm_config_include: 'dev',
      npm_config_install_strategy: 'hoisted',
      npm_config_legacy_peer_deps: 'false',
      npm_config_omit: '',
    });
  });

  test('drops ambient npm configuration and pins isolated user and global config', () => {
    const env = npmEnvironment(
      {
        PATH: '/trusted/bin',
        HTTPS_PROXY: 'http://proxy.test:3128',
        npm_config_workspace: 'apps/console',
        npm_config_proxy: 'http://untrusted-proxy.test:3128',
        npm_config_cache: '/tmp/untrusted-cache',
        NPM_CONFIG_WORKSPACES: 'false',
        npm_config_registry: 'https://untrusted.example.test',
        NPM_CONFIG_USERCONFIG: '/tmp/untrusted-user-npmrc',
        npm_config_globalconfig: '/tmp/untrusted-global-npmrc',
      },
      {
        userConfigPath: '/tmp/isolated-user-npmrc',
        globalConfigPath: '/tmp/isolated-global-npmrc',
      },
    );

    expect(env.PATH).toBe('/trusted/bin');
    expect(env.HTTPS_PROXY).toBe('http://proxy.test:3128');
    expect(env).not.toHaveProperty('npm_config_workspace');
    expect(env).not.toHaveProperty('NPM_CONFIG_WORKSPACES');
    expect(env).not.toHaveProperty('npm_config_registry');
    expect(env).not.toHaveProperty('npm_config_proxy');
    expect(env).not.toHaveProperty('npm_config_cache');
    expect(env).not.toHaveProperty('NPM_CONFIG_USERCONFIG');
    expect(env.npm_config_userconfig).toBe(path.resolve('/tmp/isolated-user-npmrc'));
    expect(env.npm_config_globalconfig).toBe(path.resolve('/tmp/isolated-global-npmrc'));
  });

  test('redacts credentialed proxy values from npm failure details', () => {
    const proxy = (['http',":","/","/",'proxy-user',":",'proxy-password',"@",'proxy.test',":",'3128'].join(""));
    const runner = createNpmRunner({
      npmCli: __filename,
      spawn: () => ({
        status: 1,
        stdout: `using ${proxy}`,
        stderr: `request through ${proxy} failed`,
      }),
    });

    expect(() => runner({ args: ['install'], cwd: __dirname, env: { HTTPS_PROXY: proxy }, label: 'test' }))
      .toThrow(/\[REDACTED\]/);
    expect(() => runner({ args: ['install'], cwd: __dirname, env: { HTTPS_PROXY: proxy }, label: 'test' }))
      .not.toThrow(proxy);
  });

  test('write mode publishes atomically only after complete validation', () => {
    const { root } = createFixture();
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-write-parent-'));
    try {
      const summary = execute({
        mode: 'write',
        repoRoot: root,
        nodeVersion: '24.18.0',
        tempParent,
        npmRunner: ({ args, cwd }) => {
          if (args[0] === '--version') return '11.16.0';
          if (args[0] === 'install') {
            const lockPath = path.join(cwd, 'package-lock.json');
            const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            lock.generated = true;
            writeJson(lockPath, lock);
          }
          return '';
        },
      });
      expect(summary.mode).toBe('write');
      expect(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).generated).toBe(true);
      expect(fs.readdirSync(tempParent)).toEqual([]);
    } finally {
      cleanup(root);
      cleanup(tempParent);
    }
  });

  test('accepts one normalization pass before two byte-identical proof passes', () => {
    const { root } = createFixture();
    let installPass = 0;
    try {
      const summary = execute({
        mode: 'write',
        repoRoot: root,
        nodeVersion: '24.18.0',
        npmRunner: ({ args, cwd }) => {
          if (args[0] === '--version') return '11.16.0';
          if (args[0] === 'install') {
            installPass += 1;
            if (installPass === 1) {
              const lockPath = path.join(cwd, 'package-lock.json');
              const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
              lock.normalized = true;
              writeJson(lockPath, lock);
            }
          }
          return '';
        },
      });
      expect(summary.mode).toBe('write');
      expect(installPass).toBe(3);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).normalized).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test('write mode leaves the committed lock unchanged when late validation fails', () => {
    const { root } = createFixture();
    const before = fs.readFileSync(path.join(root, 'package-lock.json'));
    try {
      expect(() =>
        execute({
          mode: 'write',
          repoRoot: root,
          nodeVersion: '24.18.0',
          npmRunner: ({ args, cwd }) => {
            if (args[0] === '--version') return '11.16.0';
            if (args[0] === 'install') {
              const lockPath = path.join(cwd, 'package-lock.json');
              const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
              lock.generated = true;
              writeJson(lockPath, lock);
            }
            if (args[0] === 'ci') throw new Error('late clean install failure');
            return '';
          },
        }),
      ).toThrow('late clean install failure');
      expect(fs.readFileSync(path.join(root, 'package-lock.json'))).toEqual(before);
    } finally {
      cleanup(root);
    }
  });

  test('rejects a lock that does not reach a fixed point', () => {
    const { root } = createFixture();
    let installPass = 0;
    try {
      expect(() =>
        execute({
          mode: 'check',
          repoRoot: root,
          nodeVersion: '24.18.0',
          npmRunner: ({ args, cwd }) => {
            if (args[0] === '--version') return '11.16.0';
            if (args[0] === 'install') {
              installPass += 1;
              const lockPath = path.join(cwd, 'package-lock.json');
              const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
              lock.generation = installPass;
              writeJson(lockPath, lock);
            }
            return '';
          },
        }),
      ).toThrow('did not reach a byte-identical fixed point');
    } finally {
      cleanup(root);
    }
  });

  test('check mode is nonmutating and removes its temporary workspace', () => {
    const { root } = createFixture();
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-check-parent-'));
    const before = fs.readFileSync(path.join(root, 'package-lock.json'));
    const calls = [];
    try {
      const summary = execute({
        mode: 'check',
        repoRoot: root,
        nodeVersion: '24.18.0',
        npmRunner: unchangedRunner(calls),
        tempParent,
      });
      expect(summary.mode).toBe('check');
      expect(fs.readFileSync(path.join(root, 'package-lock.json'))).toEqual(before);
      expect(calls.filter((call) => call.args[0] === 'install')[0].cwd).not.toBe(root);
      expect(fs.readdirSync(tempParent)).toEqual([]);
    } finally {
      cleanup(root);
      cleanup(tempParent);
    }
  });

  test('check mode rejects regenerated drift and cleans temporary state', () => {
    const { root } = createFixture();
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-drift-parent-'));
    try {
      expect(() =>
        execute({
          mode: 'check',
          repoRoot: root,
          nodeVersion: '24.18.0',
          tempParent,
          npmRunner: ({ args, cwd }) => {
            if (args[0] === '--version') return '11.16.0';
            if (args[0] === 'install') {
              const lockPath = path.join(cwd, 'package-lock.json');
              const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
              lock.generated_drift = true;
              writeJson(lockPath, lock);
            }
            return '';
          },
        }),
      ).toThrow('is not deterministic');
      expect(fs.readdirSync(tempParent)).toEqual([]);
    } finally {
      cleanup(root);
      cleanup(tempParent);
    }
  });

  test('check mode cleans temporary state when generation fails', () => {
    const { root } = createFixture();
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-failure-parent-'));
    try {
      expect(() =>
        execute({
          mode: 'check',
          repoRoot: root,
          nodeVersion: '24.18.0',
          tempParent,
          npmRunner: ({ args }) => {
            if (args[0] === '--version') return '11.16.0';
            throw new Error('generation failed');
          },
        }),
      ).toThrow('generation failed');
      expect(fs.readdirSync(tempParent)).toEqual([]);
    } finally {
      cleanup(root);
      cleanup(tempParent);
    }
  });

  test.each([
    ['malformed JSON', '{'],
    ['wrong lockfile version', JSON.stringify({ lockfileVersion: 2, packages: { '': {} } })],
    ['missing root entry', JSON.stringify({ lockfileVersion: 3, packages: {} })],
  ])('rejects %s', (_label, body) => {
    const { root } = createFixture();
    try {
      expect(() => validatePackageLock(root, body)).toThrow();
    } finally {
      cleanup(root);
    }
  });

  test('rejects missing workspace entries and dependency drift', () => {
    const { root, lock } = createFixture();
    try {
      const missing = structuredClone(lock);
      delete missing.packages['apps/app'];
      expect(() => validatePackageLock(root, JSON.stringify(missing))).toThrow('missing workspace entry apps/app');

      const drifted = structuredClone(lock);
      drifted.packages['packages/lib'].devDependencies.beta = '^9.0.0';
      expect(() => validatePackageLock(root, JSON.stringify(drifted))).toThrow('does not match its package.json');
    } finally {
      cleanup(root);
    }
  });
});
