const net = require('net');

const {
  buildMobileBootstrapEnv,
  classifyStrictFailureClass,
  createStrictSummary,
  ensureMobileRuntimeReady,
  parsePositivePort,
  normalizeWindowsExecPath,
  buildFieldopsDriverGoLiveIntegrationArgs,
  buildFieldopsDriverGoLiveIntegrationEnv,
  applyLocalCiFieldopsBuildEnvDefaults,
  resolveBundledWindowsNpmCli,
  resolveBundledWindowsNpxCli,
  resolveFieldopsE2ePort,
  resolveStrictStepTimeoutMs,
  resolveStepCommand,
} = require('../../../scripts/ops/verify-mobile-fieldops-strict');

describe('verify-mobile-fieldops-strict', () => {
  test('parsePositivePort accepts valid ports and rejects invalid values', () => {
    expect(parsePositivePort('8081')).toBe(8081);
    expect(parsePositivePort('0')).toBe(0);
    expect(parsePositivePort('70000')).toBe(0);
    expect(parsePositivePort('abc')).toBe(0);
  });

  test('resolveFieldopsE2ePort keeps an explicit configured port', async () => {
    await expect(
      resolveFieldopsE2ePort(
        { FIELDOPS_E2E_PORT: '19001' },
        { logger: { log: jest.fn(), warn: jest.fn() } },
      ),
    ).resolves.toBe(19001);
  });

  test('resolveFieldopsE2ePort falls back when the preferred port is already occupied', async () => {
    const occupiedServer = net.createServer();
    await new Promise((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', resolve);
    });

    const address = occupiedServer.address();
    const occupiedPort = Number(address && typeof address === 'object' ? address.port : 0);

    try {
      const logger = { log: jest.fn(), warn: jest.fn() };
      const chosenPort = await resolveFieldopsE2ePort(
        {},
        {
          preferredPort: occupiedPort,
          logger,
        },
      );

      expect(chosenPort).toBeGreaterThan(0);
      expect(chosenPort).not.toBe(occupiedPort);
      expect(logger.log).toHaveBeenCalled();
    } finally {
      await new Promise((resolve, reject) => {
        occupiedServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  test('classifyStrictFailureClass keeps mobile failure reasons explicit', () => {
    expect(classifyStrictFailureClass('typecheck:fieldops')).toBe('typecheck');
    expect(classifyStrictFailureClass('unit-test-coverage')).toBe('unit-coverage');
    expect(classifyStrictFailureClass('db-bootstrap')).toBe('db-bootstrap');
    expect(classifyStrictFailureClass('fieldops:store:preflight')).toBe('store-preflight');
  });

  test('createStrictSummary initializes a machine-readable passing payload', () => {
    expect(
      createStrictSummary({ FIELDOPS_STORE_PREFLIGHT_PROFILE: 'ci' }),
    ).toEqual(
      expect.objectContaining({
        status: 'passed',
        failed_step: '',
        failure_class: '',
        store_preflight_profile: 'ci',
        store_preflight_skipped: false,
        e2e_skipped: false,
        steps: [],
      }),
    );
  });

  test('bounds strict subprocess steps with integration-specific timeout overrides', () => {
    expect(resolveStrictStepTimeoutMs('typecheck:fieldops', {})).toBe(1_200_000);
    expect(resolveStrictStepTimeoutMs('test:integration fieldops driver go-live', {})).toBe(900_000);
    expect(
      resolveStrictStepTimeoutMs('test:integration fieldops driver go-live', {
        FIELDOPS_STRICT_INTEGRATION_TIMEOUT_MS: '12345',
      }),
    ).toBe(12_345);
    expect(
      resolveStrictStepTimeoutMs('typecheck:fieldops', {
        FIELDOPS_STRICT_STEP_TIMEOUT_MS: '54321',
      }),
    ).toBe(54_321);
  });

  test('runs FieldOps driver go-live through the bounded integration runner', () => {
    expect(buildFieldopsDriverGoLiveIntegrationArgs().map((entry) => entry.replace(/\\/g, '/'))).toEqual([
      'scripts/tests/run-integration-cloud.js',
      '--runTestsByPath',
      'tests/integration/fieldops/fieldops-driver-go-live.test.js',
    ]);
    expect(
      buildFieldopsDriverGoLiveIntegrationEnv({
        INTEGRATION_JEST_FORCE_EXIT: '',
        SUPABASE_URL: 'https://example.test',
      }),
    ).toEqual(
      expect.objectContaining({
        INTEGRATION_JEST_FORCE_EXIT: 'true',
        SUPABASE_URL: 'https://example.test',
      }),
    );
  });

  test('buildMobileBootstrapEnv grants a longer bounded DB wait for local ephemeral verification', () => {
    expect(
      buildMobileBootstrapEnv(
        {
          ENV_FILE: 'config\\env\\.env.local',
          CLOUD_DB_BOOTSTRAP_MODE: 'ephemeral',
        },
        {
          bootstrapMode: 'ephemeral',
        },
      ),
    ).toEqual(
      expect.objectContaining({
        ENV_FILE: 'config\\env\\.env.local',
        CLOUD_DB_BOOTSTRAP_MODE: 'ephemeral',
        DB_SMOKE_MAX_WAIT_MS: '600000',
      }),
    );
  });

  test('buildMobileBootstrapEnv preserves an explicit DB smoke wait override', () => {
    const env = {
      ENV_FILE: 'config\\env\\.env.local',
      CLOUD_DB_BOOTSTRAP_MODE: 'ephemeral',
      DB_SMOKE_MAX_WAIT_MS: '12345',
    };

    expect(buildMobileBootstrapEnv(env, { bootstrapMode: 'ephemeral' })).toBe(env);
  });

  test('applyLocalCiFieldopsBuildEnvDefaults seeds public native ids only for local ci profile', () => {
    expect(
      applyLocalCiFieldopsBuildEnvDefaults({
        FIELDOPS_STORE_PREFLIGHT_PROFILE: 'ci',
      }),
    ).toEqual(
      expect.objectContaining({
        NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS: 'com.masarx.fieldops',
        NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS: 'com.masarx.fieldops',
        NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS: '8b7b3e65-e22e-4ef7-949e-21c62f02506d',
      }),
    );

    const ciEnv = {
      FIELDOPS_STORE_PREFLIGHT_PROFILE: 'ci',
      GITHUB_ACTIONS: 'true',
    };
    expect(applyLocalCiFieldopsBuildEnvDefaults(ciEnv)).toBe(ciEnv);

    const releaseEnv = {
      FIELDOPS_STORE_PREFLIGHT_PROFILE: 'release',
    };
    expect(applyLocalCiFieldopsBuildEnvDefaults(releaseEnv)).toBe(releaseEnv);
  });

  test('ensureMobileRuntimeReady reuses shared-lane DB preflight evidence', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        ensureMobileRuntimeReady({
          CLOUD_DB_BOOTSTRAP_MODE: 'shared-strict',
          SHARED_LANE_PREFLIGHT_OK: '1',
          SHARED_LANE_DB_PROBE_OK: '1',
          SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME: 'DATABASE_URL',
        }),
      ).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(
        '[verify:mobile:fieldops:strict] db:bootstrap candidate=DATABASE_URL bootstrapped=false reason=shared_lane_preflight_reused',
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test('normalizes quoted Windows node executable paths', () => {
    expect(normalizeWindowsExecPath('"C:\\Program Files\\nodejs\\node.exe"'))
      .toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(resolveBundledWindowsNpmCli('D:\\Node\\node.exe'))
      .toBe('D:\\Node\\node_modules\\npm\\bin\\npm-cli.js');
    expect(resolveBundledWindowsNpxCli('"D:\\Node\\node.exe"'))
      .toBe('D:\\Node\\node_modules\\npm\\bin\\npx-cli.js');
  });

  test('uses bundled npm cli through node.exe on Windows when available', () => {
    const nodeExe = '"C:\\Program Files\\nodejs\\node.exe"';
    const bundledWindowsNpmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const seenCandidates = [];
    expect(
      resolveStepCommand('npm.cmd', ['run', 'test:e2e:fieldops'], {
        platform: 'win32',
        processExecPath: nodeExe,
        existsSyncFn: (candidate) => {
          seenCandidates.push(candidate);
          return candidate === bundledWindowsNpmCli;
        },
      }),
    ).toEqual({
      cmd: 'C:\\Program Files\\nodejs\\node.exe',
      args: [bundledWindowsNpmCli, 'run', 'test:e2e:fieldops'],
    });
    expect(seenCandidates).toEqual([bundledWindowsNpmCli]);
  });

  test('falls back to cmd.exe shell command quoting on Windows when bundled cli is unavailable', () => {
    expect(
      resolveStepCommand('custom command', ['arg with spaces'], {
        platform: 'win32',
        comSpec: 'C:\\Windows\\System32\\cmd.exe',
        existsSyncFn: () => false,
      }),
    ).toEqual({
      cmd: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"custom command" "arg with spaces"'],
    });
  });
});
