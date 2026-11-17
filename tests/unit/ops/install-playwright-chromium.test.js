const {
  buildInstallArgs,
  shouldUseWithDeps,
  isHostedRunner,
  isSelfHostedRunner,
  detectChromiumAvailability,
  detectChromiumLaunchability,
  classifyInstallMode,
  shouldRepairBrowserImageDrift,
  resolveFallbackBrowsersPath,
  prepareBrowserInstallEnvironment,
  buildBrowserImageDriftMessage,
  buildPlaywrightModuleMissingMessage,
  exportPlaywrightBrowsersPathToGithubEnv,
  ensurePlaywrightChromium,
  resolveBundledWindowsNpxCli,
  resolveInstallCommand,
  primePlaywrightBrowsersPath,
} = require('../../../scripts/ops/ci/install-playwright-chromium');

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

describe('install-playwright-chromium', () => {
  test('defaults Linux CI installs to playwright --with-deps', () => {
    expect(buildInstallArgs({ platform: 'linux', sourceEnv: {} })).toEqual([
      '--no-install',
      'playwright',
      'install',
      '--with-deps',
      'chromium',
    ]);
  });

  test('keeps non-Linux installs plain by default', () => {
    expect(buildInstallArgs({ platform: 'darwin', sourceEnv: {} })).toEqual([
      '--no-install',
      'playwright',
      'install',
      'chromium',
    ]);
  });

  test('supports explicit override modes', () => {
    expect(
      shouldUseWithDeps({
        platform: 'darwin',
        sourceEnv: { PLAYWRIGHT_INSTALL_WITH_DEPS: 'true' },
      }),
    ).toBe(true);
    expect(
      shouldUseWithDeps({
        platform: 'linux',
        sourceEnv: { PLAYWRIGHT_INSTALL_WITH_DEPS: 'false' },
      }),
    ).toBe(false);
  });

  test('keeps self-hosted Linux installs plain in auto mode', () => {
    expect(
      buildInstallArgs({
        platform: 'linux',
        sourceEnv: { RUNNER_ENVIRONMENT: 'self-hosted' },
      }),
    ).toEqual([
      '--no-install',
      'playwright',
      'install',
      'chromium',
    ]);
  });

  test('keeps --with-deps on github-hosted Linux runners', () => {
    expect(
      buildInstallArgs({
        platform: 'linux',
        sourceEnv: { RUNNER_ENVIRONMENT: 'github-hosted' },
      }),
    ).toEqual([
      '--no-install',
      'playwright',
      'install',
      '--with-deps',
      'chromium',
    ]);
  });

  test('detects hosted runners and skips install when the expected browser is already present', () => {
    expect(isHostedRunner({ RUNNER_ENVIRONMENT: 'github-hosted' })).toBe(true);
    expect(isHostedRunner({ RUNNER_ENVIRONMENT: 'self-hosted' })).toBe(false);
    expect(isSelfHostedRunner({ RUNNER_ENVIRONMENT: 'self-hosted' })).toBe(true);
    expect(isSelfHostedRunner({ RUNNER_ENVIRONMENT: 'github-hosted' })).toBe(false);

    const status = detectChromiumAvailability({
      sourceEnv: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
      requireFn: () => ({
        chromium: {
          executablePath: () => '/ms-playwright/chromium-123/chrome-linux/chrome',
        },
      }),
      existsSyncFn: () => true,
    });

    expect(status).toMatchObject({
      available: true,
      executablePath: '/ms-playwright/chromium-123/chrome-linux/chrome',
      expectedBrowsersPath: '/ms-playwright',
      usesConfiguredBrowsersPath: true,
    });
    expect(classifyInstallMode({
      sourceEnv: { RUNNER_ENVIRONMENT: 'self-hosted', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
      browserStatus: status,
    })).toBe('already-available');
  });

  test('classifies missing self-hosted Chromium as browser image drift', () => {
    const browserStatus = detectChromiumAvailability({
      sourceEnv: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
      requireFn: () => ({
        chromium: {
          executablePath: () => '/ms-playwright/chromium-123/chrome-linux/chrome',
        },
      }),
      existsSyncFn: () => false,
    });

    expect(browserStatus.available).toBe(false);
    expect(classifyInstallMode({
      sourceEnv: { RUNNER_ENVIRONMENT: 'self-hosted', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
      browserStatus,
    })).toBe('browser-image-drift');
    expect(classifyInstallMode({
      sourceEnv: { RUNNER_ENVIRONMENT: 'github-hosted', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
      browserStatus,
    })).toBe('runtime-install');
  });

  test('detects missing Playwright module without failing setup probes', () => {
    const missingModule = new Error("Cannot find module 'playwright'");
    missingModule.code = 'MODULE_NOT_FOUND';
    const sourceEnv = { RUNNER_ENVIRONMENT: 'self-hosted' };

    const browserStatus = detectChromiumAvailability({
      sourceEnv,
      contract: {
        profiles: {
          browser: {
            playwright_browsers_path: '/ms-playwright',
          },
        },
      },
      requireFn: () => {
        throw missingModule;
      },
      existsSyncFn: () => true,
    });

    expect(browserStatus).toMatchObject({
      available: false,
      moduleAvailable: false,
      executablePath: '',
      expectedBrowsersPath: '/ms-playwright',
      usesConfiguredBrowsersPath: false,
    });
    expect(sourceEnv.PLAYWRIGHT_BROWSERS_PATH).toBe('/ms-playwright');
    expect(classifyInstallMode({ sourceEnv, browserStatus })).toBe('playwright-module-missing');
  });

  test('repairs self-hosted browser image drift into a writable fallback cache by default', () => {
    const sourceEnv = { RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_TEMP: '/runner-temp' };
    const created = [];
    const installContext = prepareBrowserInstallEnvironment({
      sourceEnv,
      browserStatus: {
        available: false,
        executablePath: '/ms-playwright/chromium-123/chrome-linux/chrome',
        expectedBrowsersPath: '/ms-playwright',
      },
      mkdirSyncFn: (targetPath) => created.push(targetPath),
    });

    expect({
      ...installContext,
      fallbackBrowsersPath: normalizePath(installContext.fallbackBrowsersPath),
    }).toEqual({
      installMode: 'runtime-install',
      repairedBrowserDrift: true,
      fallbackBrowsersPath: '/runner-temp/playwright-browsers',
    });
    expect(normalizePath(sourceEnv.PLAYWRIGHT_BROWSERS_PATH)).toBe('/runner-temp/playwright-browsers');
    expect(created.map(normalizePath)).toEqual(['/runner-temp/playwright-browsers']);
  });

  test('supports disabling self-hosted browser drift repair', () => {
    const sourceEnv = {
      RUNNER_ENVIRONMENT: 'self-hosted',
      PLAYWRIGHT_REPAIR_BROWSER_IMAGE_DRIFT: 'false',
    };

    expect(shouldRepairBrowserImageDrift({ sourceEnv })).toBe(false);
    expect(
      prepareBrowserInstallEnvironment({
        sourceEnv,
        browserStatus: {
          available: false,
          executablePath: '/ms-playwright/chromium-123/chrome-linux/chrome',
          expectedBrowsersPath: '/ms-playwright',
        },
      }),
    ).toEqual({
      installMode: 'browser-image-drift',
      repairedBrowserDrift: false,
      fallbackBrowsersPath: '',
    });
    expect(sourceEnv.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });

  test('resolves fallback browsers path from env or repo temp defaults', () => {
    expect(
      resolveFallbackBrowsersPath({
        sourceEnv: { PLAYWRIGHT_FALLBACK_BROWSERS_PATH: '/custom-playwright-cache' },
      }),
    ).toBe('/custom-playwright-cache');
    expect(
      normalizePath(resolveFallbackBrowsersPath({
        sourceEnv: { RUNNER_TEMP: '/runner-temp' },
      })),
    ).toBe('/runner-temp/playwright-browsers');
    expect(
      normalizePath(resolveFallbackBrowsersPath({
        sourceEnv: {},
        repoRootPath: '/repo',
      })),
    ).toBe('/repo/tmp/playwright-browsers');
  });

  test('primes self-hosted browsers path from the runner image contract', () => {
    const sourceEnv = { RUNNER_ENVIRONMENT: 'self-hosted' };
    const contract = {
      profiles: {
        browser: {
          playwright_browsers_path: '/ms-playwright',
        },
      },
    };

    expect(primePlaywrightBrowsersPath({ sourceEnv, contract })).toBe('/ms-playwright');
    expect(sourceEnv.PLAYWRIGHT_BROWSERS_PATH).toBe('/ms-playwright');
  });

  test('does not overwrite explicit or github-hosted browsers paths', () => {
    const hostedEnv = { RUNNER_ENVIRONMENT: 'github-hosted' };
    const explicitEnv = {
      RUNNER_ENVIRONMENT: 'self-hosted',
      PLAYWRIGHT_BROWSERS_PATH: '/custom-playwright',
    };
    const contract = {
      profiles: {
        browser: {
          playwright_browsers_path: '/ms-playwright',
        },
      },
    };

    expect(primePlaywrightBrowsersPath({ sourceEnv: hostedEnv, contract })).toBe('');
    expect(hostedEnv.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
    expect(primePlaywrightBrowsersPath({ sourceEnv: explicitEnv, contract })).toBe('/custom-playwright');
    expect(explicitEnv.PLAYWRIGHT_BROWSERS_PATH).toBe('/custom-playwright');
  });

  test('exports an available browsers path into GITHUB_ENV when present', () => {
    const appendFileSyncFn = jest.fn();
    expect(
      exportPlaywrightBrowsersPathToGithubEnv({
        sourceEnv: {
          PLAYWRIGHT_BROWSERS_PATH: '/runner-temp/playwright-browsers',
          GITHUB_ENV: '/tmp/github-env',
        },
        existsSyncFn: (candidate) => candidate === '/runner-temp/playwright-browsers',
        appendFileSyncFn,
      }),
    ).toBe(true);
    const githubEnvCall = appendFileSyncFn.mock.calls[0];
    expect(githubEnvCall[0]).toBe('/tmp/github-env');
    expect(normalizePath(githubEnvCall[1])).toBe('PLAYWRIGHT_BROWSERS_PATH=/runner-temp/playwright-browsers\n');
    expect(githubEnvCall[2]).toBe('utf8');
  });

  test('ensurePlaywrightChromium repairs drift in-process and exports the fallback path', () => {
    const sourceEnv = {
      RUNNER_ENVIRONMENT: 'self-hosted',
      RUNNER_TEMP: '/runner-temp',
      GITHUB_ENV: '/tmp/github-env',
    };
    const logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const appendFileSyncFn = jest.fn();
    const spawnSyncFn = jest.fn(() => ({ status: 0 }));

    const result = ensurePlaywrightChromium({
      sourceEnv,
      platform: 'linux',
      logger,
      requireFn: () => ({
        chromium: {
          executablePath: () => '/ms-playwright/chromium-123/chrome-linux/chrome',
        },
      }),
      existsSyncFn: (candidate) => normalizePath(candidate) === '/runner-temp/playwright-browsers',
      mkdirSyncFn: jest.fn(),
      spawnSyncFn,
      appendFileSyncFn,
      githubEnvPath: '/tmp/github-env',
    });

    expect({
      ...result,
      fallbackBrowsersPath: normalizePath(result.fallbackBrowsersPath),
      browsersPath: normalizePath(result.browsersPath),
    }).toMatchObject({
      installMode: 'runtime-install',
      repairedBrowserDrift: true,
      fallbackBrowsersPath: '/runner-temp/playwright-browsers',
      browsersPath: '/runner-temp/playwright-browsers',
      exportedToGithubEnv: true,
    });
    expect(normalizePath(sourceEnv.PLAYWRIGHT_BROWSERS_PATH)).toBe('/runner-temp/playwright-browsers');
    expect(logger.warn).toHaveBeenCalled();
    expect(spawnSyncFn).toHaveBeenCalledWith(
      'npx',
      ['--no-install', 'playwright', 'install', 'chromium'],
      expect.objectContaining({
        env: sourceEnv,
        shell: false,
        stdio: 'inherit',
      }),
    );
    const githubEnvCall = appendFileSyncFn.mock.calls[0];
    expect(githubEnvCall[0]).toBe('/tmp/github-env');
    expect(normalizePath(githubEnvCall[1])).toBe('PLAYWRIGHT_BROWSERS_PATH=/runner-temp/playwright-browsers\n');
    expect(githubEnvCall[2]).toBe('utf8');
  });

  test('ensurePlaywrightChromium fails closed when drift repair is disabled', () => {
    const sourceEnv = {
      RUNNER_ENVIRONMENT: 'self-hosted',
      PLAYWRIGHT_REPAIR_BROWSER_IMAGE_DRIFT: 'false',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    };
    const logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    expect(() =>
      ensurePlaywrightChromium({
        sourceEnv,
        logger,
        requireFn: () => ({
          chromium: {
            executablePath: () => '/ms-playwright/chromium-123/chrome-linux/chrome',
          },
        }),
        existsSyncFn: () => false,
      }),
    ).toThrow(
      buildBrowserImageDriftMessage({
        expectedBrowsersPath: '/ms-playwright',
        executablePath: '/ms-playwright/chromium-123/chrome-linux/chrome',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith('failure_class=browser-image-drift');
  });

  test('ensurePlaywrightChromium fails closed when dependencies are missing', () => {
    const missingModule = new Error("Cannot find module 'playwright'");
    missingModule.code = 'MODULE_NOT_FOUND';
    const logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const spawnSyncFn = jest.fn();

    expect(() =>
      ensurePlaywrightChromium({
        sourceEnv: { RUNNER_ENVIRONMENT: 'self-hosted' },
        logger,
        requireFn: () => {
          throw missingModule;
        },
        existsSyncFn: () => true,
        spawnSyncFn,
      }),
    ).toThrow(buildPlaywrightModuleMissingMessage());
    expect(logger.error).toHaveBeenCalledWith('failure_class=playwright-module-missing');
    expect(spawnSyncFn).not.toHaveBeenCalled();
  });

  test('resolves bundled Windows npx cli from the provided node executable', () => {
    expect(
      resolveBundledWindowsNpxCli('D:\\Node\\node.exe'),
    ).toBe('D:\\Node\\node_modules\\npm\\bin\\npx-cli.js');
    expect(
      resolveBundledWindowsNpxCli('"D:\\Node\\node.exe"'),
    ).toBe('D:\\Node\\node_modules\\npm\\bin\\npx-cli.js');
  });

  test('uses bundled npx cli through node.exe on Windows when available', () => {
    const bundledWindowsNpxCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';
    const seenCandidates = [];
    expect(
      resolveInstallCommand({
        platform: 'win32',
        processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
        sourceEnv: {},
        existsSyncFn: (candidate) => {
          seenCandidates.push(candidate);
          return candidate === bundledWindowsNpxCli;
        },
      }),
    ).toEqual({
      cmd: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        bundledWindowsNpxCli,
        '--no-install',
        'playwright',
        'install',
        'chromium',
      ],
      shell: false,
    });
    expect(seenCandidates).toEqual([bundledWindowsNpxCli]);
  });

  test('falls back to npx.cmd when bundled Windows npx cli is unavailable', () => {
    expect(
      resolveInstallCommand({
        platform: 'win32',
        sourceEnv: {},
        existsSyncFn: () => false,
      }),
    ).toEqual({
      cmd: 'npx.cmd',
      args: ['--no-install', 'playwright', 'install', 'chromium'],
      shell: false,
    });
  });
});
