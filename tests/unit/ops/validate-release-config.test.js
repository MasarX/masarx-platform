const path = require('path');

const {
  buildValidationPlan,
  loadEasProfileEnv,
  parseArgs,
  resolveSpawnInvocation,
  runStep,
  runValidation,
} = require('../../../scripts/ops/mobile/validate-release-config');

describe('validate-release-config', () => {
  const appDir = path.join(process.cwd(), 'apps', 'fieldops');

  test('parseArgs resolves workflow flags', () => {
    expect(
      parseArgs([
        '--profile',
        'stg',
        '--platform',
        'all',
        '--execute-release',
        '1',
        '--eas-cli-version',
        '18.0.1',
      ]),
    ).toEqual({
      appDir: '',
      executeRelease: true,
      easCliVersion: '18.0.1',
      platform: 'all',
      profile: 'stg',
    });
  });

  test('loadEasProfileEnv returns build profile env for stg', () => {
    expect(loadEasProfileEnv({ appDir, profile: 'stg' })).toEqual({
      FIELDOPS_BUILD_PROFILE: 'stg',
      NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX: '.stg',
    });
  });

  test('uses local expo config for validation-only runs without EXPO_TOKEN', () => {
    const plan = buildValidationPlan({
      appDir,
      easCliVersion: '18.0.1',
      env: {
        EXPO_TOKEN: '',
      },
      executeRelease: false,
      platform: 'all',
      profile: 'stg',
    });

    expect(plan.mode).toBe('local-expo-config');
    expect(plan.env.FIELDOPS_BUILD_PROFILE).toBe('stg');
    expect(plan.env.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX).toBe('.stg');
    expect(plan.steps).toEqual([
      {
        label: 'tool-version',
        cmd: 'npx',
        args: ['expo', '--version'],
      },
      {
        label: 'expo-config',
        cmd: 'npx',
        args: ['expo', 'config', '--json'],
      },
    ]);
  });

  test('uses EAS config when execute_release is true', () => {
    const plan = buildValidationPlan({
      appDir,
      easCliVersion: '18.0.1',
      env: {
        EXPO_TOKEN: '',
      },
      executeRelease: true,
      platform: 'all',
      profile: 'stg',
    });

    expect(plan.mode).toBe('eas-config');
    expect(plan.steps).toEqual([
      {
        label: 'tool-version',
        cmd: 'npx',
        args: ['eas-cli@18.0.1', '--version'],
      },
      {
        label: 'eas-config-android',
        cmd: 'npx',
        args: ['eas-cli@18.0.1', 'config', '--profile', 'stg', '--platform', 'android', '--non-interactive'],
      },
      {
        label: 'eas-config-ios',
        cmd: 'npx',
        args: ['eas-cli@18.0.1', 'config', '--profile', 'stg', '--platform', 'ios', '--non-interactive'],
      },
    ]);
  });

  test('uses EAS config for validation-only runs when EXPO_TOKEN exists', () => {
    const plan = buildValidationPlan({
      appDir,
      easCliVersion: '18.0.1',
      env: {
        EXPO_TOKEN: 'expo-token',
      },
      executeRelease: false,
      platform: 'android',
      profile: 'stg',
    });

    expect(plan.mode).toBe('eas-config');
    expect(plan.steps[1]).toEqual({
      label: 'eas-config-android',
      cmd: 'npx',
      args: ['eas-cli@18.0.1', 'config', '--profile', 'stg', '--platform', 'android', '--non-interactive'],
    });
  });

  test('runValidation executes the planned commands in order', () => {
    const spawnSyncImpl = jest.fn(() => ({ status: 0, stdout: '', stderr: '' }));

    const plan = runValidation({
      appDir,
      easCliVersion: '18.0.1',
      env: { EXPO_TOKEN: '' },
      executeRelease: false,
      platform: 'all',
      processPlatform: 'linux',
      profile: 'stg',
      spawnSyncImpl,
    });

    expect(plan.mode).toBe('local-expo-config');
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(spawnSyncImpl.mock.calls[0][0]).toBe('npx');
    expect(spawnSyncImpl.mock.calls[0][1]).toEqual(['expo', '--version']);
    expect(spawnSyncImpl.mock.calls[1][1]).toEqual(['expo', 'config', '--json']);
    for (const call of spawnSyncImpl.mock.calls) {
      expect(call[2].cwd).toBe(appDir);
      expect(call[2].env.FIELDOPS_BUILD_PROFILE).toBe('stg');
      expect(call[2].shell).toBe(false);
      expect(call[2].windowsHide).toBe(false);
    }
  });

  test.each(['npm', 'npx'])('resolves Windows %s through the Node CLI without a shell', (command) => {
    const nodeExecPath = path.join('C:\\', 'Program Files', 'nodejs', 'node.exe');
    const scriptName = command === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
    const expectedCli = path.join(path.dirname(nodeExecPath), 'node_modules', 'npm', 'bin', scriptName);
    const args = ['config', '--profile', 'stg & echo not-a-command'];
    const spawnSyncImpl = jest.fn(() => ({ status: 0 }));
    expect(resolveSpawnInvocation({
      args,
      command,
      fsExistsSync: (filePath) => filePath === expectedCli,
      nodeExecPath,
      platform: 'win32',
    })).toEqual({ args: [expectedCli, ...args], cmd: nodeExecPath, shell: false, windowsHide: true });
    runStep({ step: { label: 'config', cmd: command, args }, cwd: appDir, env: {},
      fsExistsSync: (filePath) => filePath === expectedCli, nodeExecPath, platform: 'win32', spawnSyncImpl });
    expect(spawnSyncImpl).toHaveBeenCalledWith(nodeExecPath, [expectedCli, ...args], {
      cwd: appDir, env: {}, encoding: 'utf8', stdio: 'inherit', shell: false, windowsHide: true,
    });
  });

  test.each(['npm', 'npx'])('fails closed when the shell-free Windows %s CLI is unavailable', (command) => {
    const spawnSyncImpl = jest.fn();
    expect(() => runStep({
      step: { label: 'version', cmd: command, args: ['--version'] },
      fsExistsSync: () => false,
      nodeExecPath: path.join('C:\\', 'Program Files', 'nodejs', 'node.exe'),
      platform: 'win32',
      spawnSyncImpl,
    })).toThrow(`Unable to resolve a shell-free Windows ${command} CLI`);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  test('passes Windows invocation options through the existing validation runner', () => {
    const nodeExecPath = path.join('C:\\', 'Program Files', 'nodejs', 'node.exe');
    const cli = path.join(path.dirname(nodeExecPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    const spawnSyncImpl = jest.fn(() => ({ status: 0 }));
    runValidation({ appDir, env: { EXPO_TOKEN: '' }, profile: 'stg', processPlatform: 'win32',
      nodeExecPath, fsExistsSync: (filePath) => filePath === cli, spawnSyncImpl });
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(spawnSyncImpl.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
      [nodeExecPath, [cli, 'expo', '--version']],
      [nodeExecPath, [cli, 'expo', 'config', '--json']],
    ]);
    for (const [, , options] of spawnSyncImpl.mock.calls) {
      expect(options).toMatchObject({ cwd: appDir, shell: false, windowsHide: true });
    }
  });

  test.each([
    [{ status: null, error: new Error('permission denied') }, 'permission denied'],
    [{ status: null, signal: 'SIGTERM' }, 'exit code <unknown>'],
  ])('does not treat a failed child process as success: %p', (result, message) => {
    expect(() => runStep({ step: { label: 'version', cmd: 'npx', args: ['--version'] },
      platform: 'linux', spawnSyncImpl: jest.fn(() => result) })).toThrow(message);
  });

  test('propagates a real child-process exit code', () => {
    expect(() => runStep({
      step: { label: 'exit-seven', cmd: process.execPath, args: ['-e', 'process.exit(7)'] },
      cwd: appDir,
      env: process.env,
    })).toThrow('exit-seven failed with exit code 7');
  });
});
