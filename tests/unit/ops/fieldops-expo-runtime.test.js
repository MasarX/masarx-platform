const fs = require('fs');
const path = require('path');

const {
  appendNodeRequireOption,
  buildFieldopsExpoEnv,
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
    const env = buildFieldopsExpoEnv({ NODE_OPTIONS: '--trace-warnings' });

    expect(env.FIELDOPS_EXPO_PROJECT_ROOT).toBe(path.resolve('apps/fieldops'));
    expect(env.NODE_OPTIONS).toContain('--trace-warnings');
    expect(env.NODE_OPTIONS).toContain('fieldops-expo-peer-resolver.cjs');
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
});
