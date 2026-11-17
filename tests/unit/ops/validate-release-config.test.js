const path = require('path');

const {
  buildValidationPlan,
  loadEasProfileEnv,
  parseArgs,
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
    }
  });
});
