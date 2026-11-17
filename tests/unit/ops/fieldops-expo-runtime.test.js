jest.mock('../../../scripts/ops/workspace/docker-runtime/git-metadata', () => ({
  runGit: jest.fn(),
}));
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

const fs = require('fs');
const path = require('path');

const {
  appendNodeRequireOption,
  buildFieldopsExpoEnv,
  resolveFieldopsRepoRoot,
  run,
} = require('../../../scripts/ops/mobile/run-fieldops-expo');
const {
  resolveProjectRoot,
} = require('../../../scripts/ops/mobile/fieldops-expo-peer-resolver.cjs');

describe('FieldOps Expo runtime launcher', () => {
  test('adds the peer resolver to NODE_OPTIONS once', () => {
    const resolverPath = path.resolve('scripts/ops/mobile/fieldops-expo-peer-resolver.cjs');
    const initial = appendNodeRequireOption('--max-old-space-size=4096', resolverPath);
    const repeated = appendNodeRequireOption(initial, resolverPath);

    expect(initial).toContain('--max-old-space-size=4096');
    expect(initial).toContain(`--require ${resolverPath}`);
    expect(repeated).toBe(initial);
  });

  test('builds an Expo environment that points at the canonical FieldOps app root', () => {
    const env = buildFieldopsExpoEnv({
      NODE_OPTIONS: '--trace-warnings',
      NEXT_PUBLIC_SUPABASE_URL: 'https://public.example.test',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon',
      EXPO_PUBLIC_SUPABASE_URL: 'https://explicit.example.test',
    });

    expect(env.FIELDOPS_EXPO_PROJECT_ROOT).toBe(path.resolve('apps/fieldops'));
    expect(env.NODE_OPTIONS).toContain('--trace-warnings');
    expect(env.NODE_OPTIONS).toContain('fieldops-expo-peer-resolver.cjs');
    expect(env.EXPO_PUBLIC_SUPABASE_URL).toBe('https://explicit.example.test');
    expect(env.EXPO_PUBLIC_SUPABASE_ANON_KEY).toBe('public-anon');
  });

  test('resolves the FieldOps app root from the repo root', () => {
    expect(resolveProjectRoot({}, process.cwd())).toBe(path.resolve('apps/fieldops'));
  });

  test('keeps FieldOps package scripts on the shared Expo launcher', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve('apps/fieldops/package.json'), 'utf8'),
    );

    expect(packageJson.scripts).toEqual(
      expect.objectContaining({
        start: 'node ../../scripts/ops/mobile/run-fieldops-expo.js start',
        android: 'node ../../scripts/ops/mobile/run-fieldops-expo.js start --android',
        ios: 'node ../../scripts/ops/mobile/run-fieldops-expo.js start --ios',
        web: 'node ../../scripts/ops/mobile/run-fieldops-expo.js start --web',
      }),
    );
  });

  test('keeps FieldOps Playwright web startup independent from Expo-hosted metadata', () => {
    const playwrightConfig = fs.readFileSync(path.resolve('playwright.fieldops.config.ts'), 'utf8');
    const metroStart = playwrightConfig.indexOf('command: `npm run web');
    expect(metroStart).toBeGreaterThanOrEqual(0);
    const webServerEnvStart = playwrightConfig.indexOf('env: {', metroStart);
    const webServerEnvEnd = playwrightConfig.indexOf('url: bundleReadyUrl,', webServerEnvStart);

    expect(webServerEnvStart).toBeGreaterThanOrEqual(0);
    expect(webServerEnvEnd).toBeGreaterThan(webServerEnvStart);

    const webServerEnv = playwrightConfig.slice(webServerEnvStart, webServerEnvEnd);
    expect(webServerEnv).toContain('EXPO_NO_TELEMETRY: "1"');
    expect(webServerEnv).toContain('EXPO_NO_DEPENDENCY_VALIDATION: "1"');
    expect(webServerEnv).toContain('EXPO_NO_METRO_WORKSPACE_ROOT: "1"');
    expect(webServerEnv).toContain('EXPO_NO_DOTENV: "1"');
    expect(playwrightConfig).toContain('"/index.ts.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable"');
    expect(playwrightConfig).toContain('url: bundleReadyUrl,');
  });
});

describe('FieldOps Android checkout admission', () => {
  const { runGit } = require('../../../scripts/ops/workspace/docker-runtime/git-metadata');
  const { spawnSync } = require('child_process');
  const repoRoot = path.resolve(__dirname, '../../..');

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('resolves and launches from a different cwd without changing the checkout', () => {
    const previous = process.cwd();
    runGit.mockReturnValue({ ok: true, value: repoRoot });
    spawnSync.mockReturnValue({ status: 0 });
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    try {
      process.chdir(require('os').tmpdir());
      expect(run(['run:android', '--no-bundler'], {})).toBe(0);
      expect(runGit).toHaveBeenCalledWith(repoRoot, ['rev-parse', '--show-toplevel']);
      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [path.join(repoRoot, 'apps/fieldops/node_modules/expo/bin/cli'), 'run:android', '--no-bundler'],
        expect.objectContaining({ cwd: path.join(repoRoot, 'apps/fieldops') }),
      );
    } finally {
      process.chdir(previous);
    }
  });

  test.each([
    { ok: false, value: '' },
    { ok: true, value: '' },
  ])('refuses missing Git authority before spawning Expo: %j', (result) => {
    runGit.mockReturnValue(result);
    expect(() => run(['run:android'], {})).toThrow(/readable Git worktree/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('refuses a different Git checkout before spawning Expo', () => {
    runGit.mockReturnValue({ ok: true, value: '/other-checkout' });
    jest.spyOn(fs, 'realpathSync').mockImplementation((value) => value);
    expect(() => run(['run:android'], {})).toThrow(/does not match/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('normalizes an alias to the same real checkout, including spaces', () => {
    runGit.mockReturnValue({ ok: true, value: '/checkout alias' });
    jest.spyOn(fs, 'realpathSync').mockImplementation((value) => {
      if (value === repoRoot || value === '/checkout alias') return '/physical checkout';
      throw new Error('unexpected root');
    });
    expect(resolveFieldopsRepoRoot()).toBe('/physical checkout');
  });

  test.each([['start', '--web'], ['start'], ['export', '--platform', 'web']])('stages web asset without Android Git admission: %j', (...argv) => {
    spawnSync.mockReturnValue({ status: 0 });
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const prepareMapWorker = jest.fn();
    expect(run(argv, {}, { prepareMapWorker })).toBe(0);
    expect(prepareMapWorker).toHaveBeenCalledWith(path.join(repoRoot, 'apps/fieldops'));
    expect(prepareMapWorker.mock.invocationCallOrder[0]).toBeLessThan(spawnSync.mock.invocationCallOrder[0]);
    expect(runGit).not.toHaveBeenCalled();
  });
});

describe('FieldOps app-local Expo config-plugin peer resolution', () => {
  const resolverPath = path.resolve('scripts/ops/mobile/fieldops-expo-peer-resolver.cjs');
  const projectRoot = path.resolve('apps/fieldops');
  const source = fs.readFileSync(resolverPath, 'utf8');
  const pluginParent = path.join(path.parse(projectRoot).root, 'repo', 'node_modules',
    '@maplibre', 'maplibre-react-native', 'lib', 'commonjs', 'plugin', 'withMapLibre.js');
  function isolated({ originalResult, code = 'MODULE_NOT_FOUND', installed = true } = {}) {
    const error = Object.assign(new Error('original resolver failure'), { code });
    const original = jest.fn(() => { if (originalResult) return originalResult; throw error; });
    const peerResult = path.join(projectRoot, 'node_modules', 'expo', 'config-plugins.js');
    const peerResolve = jest.fn(() => peerResult);
    const fakeModule = { _resolveFilename: original, createRequire: jest.fn(() => ({ resolve: peerResolve })) };
    const sandbox = { module: { exports: {} }, __dirname: path.dirname(resolverPath),
      process: { env: { FIELDOPS_EXPO_PROJECT_ROOT: projectRoot }, cwd: () => projectRoot },
      require: name => ({ fs: { existsSync: () => installed }, module: fakeModule, path })[name] };
    require('vm').runInNewContext(source, sandbox, { filename: resolverPath });
    return { resolve: fakeModule._resolveFilename, fakeModule, original, error, peerResolve, peerResult };
  }
  test('original Node resolution wins without peer substitution', () => {
    const fixture = isolated({ originalResult: '/already-resolved.js' });
    expect(fixture.resolve('expo/config-plugins', { filename: pluginParent }, false)).toBe('/already-resolved.js');
    expect(fixture.peerResolve).not.toHaveBeenCalled();
  });
  test.each(['withMapLibre.js', 'android.js', 'ios.js'].flatMap(file => [
    [file, '/'], [file, '\\'],
  ]))('resolves the public Expo peer for exact MapLibre plugin %s (%s)', (file, separator) => {
    const fixture = isolated();
    const parent = path.join(path.dirname(pluginParent), file).replace(/\\/g, '/').split('/').join(separator);
    expect(fixture.resolve('expo/config-plugins', { filename: parent }, false)).toBe(fixture.peerResult);
    expect(fixture.fakeModule.createRequire).toHaveBeenCalledWith(path.join(projectRoot, 'package.json'));
    expect(fixture.peerResolve).toHaveBeenCalledWith('expo/config-plugins');
  });
  test.each([
    ['expo/config-plugins', '/repo/node_modules/other/plugin/index.js', 'MODULE_NOT_FOUND'],
    ['expo/config-plugins', '/repo/node_modules/@maplibre/maplibre-react-native/lib/commonjs/plugin-extra/index.js', 'MODULE_NOT_FOUND'],
    ['expo/config', pluginParent, 'MODULE_NOT_FOUND'],
    ['expo/config-plugins', pluginParent, 'ERR_PACKAGE_PATH_NOT_EXPORTED'],
  ])('preserves unrelated request/caller/error: %s %s %s', (request, filename, code) => {
    const fixture = isolated({ code });
    expect(() => fixture.resolve(request, { filename }, false)).toThrow(fixture.error);
    expect(fixture.peerResolve).not.toHaveBeenCalled();
  });
  test('preserves the existing Metro package.json peer fallback', () => {
    const fixture = isolated();
    expect(fixture.resolve('expo/package.json', { filename: '/repo/node_modules/@expo/metro-config/index.js' }, false))
      .toBe(path.join(projectRoot, 'node_modules', 'expo', 'package.json'));
    expect(fixture.peerResolve).not.toHaveBeenCalled();
  });
  test('does not install a fallback without the selected app Expo package', () => {
    const fixture = isolated({ installed: false });
    expect(fixture.resolve).toBe(fixture.original);
    expect(fixture.fakeModule.createRequire).not.toHaveBeenCalled();
  });
  test('propagates a missing app-local public peer instead of inventing a target', () => {
    const fixture = isolated();
    const missing = Object.assign(new Error('app peer missing'), { code: 'MODULE_NOT_FOUND' });
    fixture.peerResolve.mockImplementation(() => { throw missing; });
    expect(() => fixture.resolve('expo/config-plugins', { filename: pluginParent }, false)).toThrow(missing);
  });
  test('loads the actual installed MapLibre plugin with the app-selected public Expo peer', () => {
    // This no-server/no-DB child bypasses this suite's launcher spawn mock.
    const script = [
      "const assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module');",
      "const app=path.resolve('apps/fieldops'),appRequire=Module.createRequire(path.join(app,'package.json'));",
      "const entry=appRequire.resolve('@maplibre/maplibre-react-native/app.plugin.js');",
      "const plugin=require(entry);assert.equal(typeof (plugin.default || plugin),'function');",
      "const peer=Module.createRequire(path.join(path.dirname(entry),'lib/commonjs/plugin/withMapLibre.js'));",
      "assert.equal(peer.resolve('expo/config-plugins'),appRequire.resolve('expo/config-plugins'));",
    ].join('\n');
    const result = jest.requireActual('child_process').spawnSync(process.execPath,
      ['--require', resolverPath, '-e', script], {
        cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: { ...process.env, FIELDOPS_EXPO_PROJECT_ROOT: projectRoot },
      });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('PWA smoke uses exported static assets without replacing the driver lifecycle', () => {
    const source = fs.readFileSync(path.resolve('playwright.fieldops.config.ts'), 'utf8');
    expect(source).toContain('FieldOps PWA smoke requires FIELDOPS_WEB_EXPORT_DIR');
    expect(source).toContain('scripts/frontend/serve-landing.js --skip-build');
    expect(source).toContain('url: `${resolvedBaseUrl}/`');
    expect(source).toContain('devices["Pixel 7"]');
    expect(source).toContain('devices["iPhone 13"]');
    expect(source).toContain('testIgnore: /pwa\\.spec\\.ts/');
  });

  test.each(['', 'http://proxy.example.test:3129'])('FieldOps browser config uses only an explicit proxy (%s)', (server) => {
    const keys = ['FIELDOPS_E2E_PROXY_SERVER', 'FIELDOPS_PWA_SMOKE'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.FIELDOPS_E2E_PROXY_SERVER = ` ${server} `;
      process.env.FIELDOPS_PWA_SMOKE = '0';
      // Evaluate configuration only, without booting Playwright's singleton runner in Jest.
      jest.doMock('@playwright/test', () => ({ defineConfig: (config) => config, devices: {} }));
      jest.doMock('node:path', () => ({ ...path, __esModule: true, default: path }));
      let config;
      jest.isolateModules(() => { config = require('../../../playwright.fieldops.config.ts').default; });
      expect(config.use.proxy).toEqual(server ? { server, bypass: 'localhost,127.0.0.1' } : undefined);
      expect(config.use.ignoreHTTPSErrors).toBeUndefined();
      expect(config.retries).toBe(0);
    } finally {
      jest.dontMock('@playwright/test');
      jest.dontMock('node:path');
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});
