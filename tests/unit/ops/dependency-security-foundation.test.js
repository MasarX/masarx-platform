const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const semver = require('semver');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function versionsForLockPackage(lock, packageName) {
  const suffix = `/node_modules/${packageName}`;
  return Array.from(
    new Set(
      Object.entries(lock.packages)
        .filter(([key, value]) => (key === `node_modules/${packageName}` || key.endsWith(suffix)) && value?.version)
        .map(([, value]) => value.version),
    ),
  ).sort();
}

describe('dependency security foundation', () => {
  test('pins the supported Web dependency cohort', () => {
    const root = readJson('package.json');
    const consoleManifest = readJson('apps/console/package.json');
    const portalManifest = readJson('apps/portal/package.json');
    const uiManifest = readJson('packages/ui/package.json');

    expect(consoleManifest.dependencies).toMatchObject({
      '@swc/helpers': '0.5.23',
      next: '16.4.5',
      'next-intl': '4.9.2',
      zod: '4.6.7',
    });
    expect(portalManifest.dependencies).toMatchObject({
      '@swc/helpers': '0.5.23',
      next: '16.4.5',
      'next-intl': '4.9.2',
      zod: '4.6.7',
    });
    expect(uiManifest.peerDependencies.next).toBe('^16.4.5');
    expect(uiManifest.dependencies['@hookform/resolvers']).toBe('5.2.2');
    expect(uiManifest.dependencies.zod).toBe('4.6.7');
    expect(root.devDependencies).toMatchObject({
      '@next/bundle-analyzer': '16.4.2',
      '@swc/helpers': '0.5.23',
      '@xmldom/xmldom': '0.9.12',
      '@next/bundle-analyzer': '16.4.2',
      'brace-expansion': '2.1.7',
      'eslint-config-next': '16.4.2',
      esbuild: '^0.25.12',
      nx: '22.7.12',
      postcss: '8.5.23',
      sharp: '0.35.5',
      undici: '6.29.1',
    });
    expect(root.overrides['@expo/plist']).toEqual({
      '@xmldom/xmldom': '0.8.15',
    });
    expect(root.overrides['nx@22.7.12']).toEqual({
      'brace-expansion': '5.0.12',
      'smol-toml': '1.9.0',
    });
    expect(root.overrides.axios).toBe('1.20.0');
    expect(root.overrides['fast-uri']).toBe('3.1.9');
    expect(root.overrides.uuid).toBe('11.1.1');
    expect(root.overrides['postcss-selector-parser@^7.0.0']).toBe('7.1.6');
    expect(root.overrides).not.toHaveProperty('postcss-selector-parser');
    expect(root.overrides['@storybook/builder-webpack5@10.6.2']).toEqual({
      'webpack-dev-middleware': '7.4.6',
    });
    expect(root.overrides['shell-quote']).toBe('1.12.0');
    expect(root.overrides['react-devtools-core']['shell-quote']).toBe('1.12.0');
    expect(root.overrides['react-devtools-core@6.1.5']['shell-quote']).toBe('1.12.0');
    expect(root.overrides.undici).toBe('6.29.1');
    expect(root.overrides['zod@^4.0.0']).toBe('4.6.7');
    expect(root.overrides).not.toHaveProperty('zod');
    expect(root.overrides.postcss).toBe('$postcss');
    expect(root.overrides.sharp).toBe('$sharp');
    expect(root.overrides['next@16.4.2']).toEqual({ postcss: '$postcss', sharp: '$sharp' });
    expect(root.overrides).not.toHaveProperty('next@16.2.11');
    expect(root.overrides).not.toHaveProperty('@expo/metro-config@54.0.14');
    expect(root.overrides).not.toHaveProperty('brace-expansion');
    expect(root.overrides).not.toHaveProperty('@xmldom/xmldom');
    expect(root.overrides).not.toHaveProperty('minimatch');
  });

  test('pins the supported Expo 55, React 19.2, and React Native 0.83.10 host cohort', () => {
    const fieldops = readJson('apps/fieldops/package.json');
    const mobileCore = readJson('packages/mobile-core/package.json');

    expect(fieldops.dependencies).toMatchObject({
      '@expo/app-integrity': '~55.0.15',
      expo: '~55.0.32',
      'expo-dev-client': '~55.0.37',
      'expo-modules-core': '55.0.27',
      react: '19.2.0',
      'react-dom': '19.2.0',
      'react-native': '0.83.10',
    });
    expect(fieldops.dependencies).not.toHaveProperty('@react-native/virtualized-lists');
    expect(mobileCore.dependencies).toEqual({
      'expo-modules-core': '55.0.27',
      'expo-sqlite': '~55.0.18',
    });
    expect(mobileCore.peerDependencies).toEqual({
      expo: '~55.0.32',
      react: '19.2.0',
      'react-native': '0.83.10',
    });
    expect(mobileCore.devDependencies).toEqual({
      '@types/react': '~19.2.0',
      expo: '55.0.32',
      react: '19.2.0',
      'react-native': '0.83.10',
    });
  });

  test('materializes the exact supported dependency graph in package-lock.json', () => {
    const lock = readJson('package-lock.json');

    expect(lock.packages['node_modules/next'].version).toBe('16.4.5');
    expect(lock.packages['node_modules/next-intl'].version).toBe('4.9.2');
    expect(lock.packages['node_modules/nx'].version).toBe('22.7.12');
    expect(semver.satisfies(lock.packages['node_modules/postcss'].version, '^8.5.23')).toBe(true);
    expect(versionsForLockPackage(lock, 'postcss').every((version) => semver.gte(version, '8.5.23'))).toBe(true);
    expect(versionsForLockPackage(lock, 'sharp').every((version) => semver.gte(version, '0.35.5'))).toBe(true);
    for (const [packageName, floor] of [
      ['axios', '1.20.0'],
      ['compression', '1.8.2'],
      ['esbuild', '0.25.12'],
      ['fast-uri', '3.1.9'],
      ['handlebars', '4.7.10'],
      ['postcss-selector-parser', '7.1.6'],
      ['shell-quote', '1.11.0'],
      ['source-map-js', '1.2.2'],
      ['undici', '6.29.1'],
      ['uuid', '11.1.1'],
      ['webpack-dev-middleware', '7.4.6'],
    ]) {
      const versions = versionsForLockPackage(lock, packageName);
      expect(versions.length).toBeGreaterThan(0);
      expect(versions.every((version) => semver.gte(version, floor))).toBe(true);
    }
    expect(versionsForLockPackage(lock, 'js-yaml').every((version) => {
      const major = semver.major(version);
      return major === 3 ? semver.gte(version, '3.15.2') : semver.gte(version, '4.3.2');
    })).toBe(true);
    expect(versionsForLockPackage(lock, '@xmldom/xmldom').every((version) => {
      if (semver.satisfies(version, '0.8.x')) return semver.gte(version, '0.8.15');
      return semver.gte(version, '0.9.12');
    })).toBe(true);
    expect(
      versionsForLockPackage(lock, 'smol-toml')
        .every((version) => semver.gte(version, '1.9.0')),
    ).toBe(true);

    expect(lock.packages['packages/mobile-core'].peerDependencies).toEqual({
      expo: '~55.0.32',
      react: '19.2.0',
      'react-native': '0.83.10',
    });
    expect(lock.packages['packages/mobile-core'].devDependencies).toEqual({
      '@types/react': '~19.2.0',
      expo: '55.0.32',
      react: '19.2.0',
      'react-native': '0.83.10',
    });
    expect(lock.packages['apps/fieldops'].dependencies['react-dom']).toBe('19.2.0');
    expect(lock.packages['apps/fieldops'].dependencies['expo-dev-client']).toBe('~55.0.37');
    expect(lock.packages['apps/fieldops'].dependencies['expo-modules-core']).toBe('55.0.27');
    expect(lock.packages['packages/ui'].dependencies['@hookform/resolvers']).toBe('5.2.2');

    expect(versionsForLockPackage(lock, 'expo')).toEqual(['55.0.32']);
    expect(versionsForLockPackage(lock, 'expo-dev-client')).toEqual(['55.0.37']);
    expect(versionsForLockPackage(lock, 'expo-modules-core')).toEqual(['55.0.27']);
    expect(versionsForLockPackage(lock, 'react')).toEqual(['19.2.0', '19.2.8']);
    expect(versionsForLockPackage(lock, 'react-dom')).toEqual(['19.2.0', '19.2.8']);
    expect(versionsForLockPackage(lock, 'react-native')).toEqual(['0.83.10']);
  });

  test('npm lock graph has no invalid or missing edges', () => {
    const npmCli = process.env.MASARX_NPM_CLI || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const command = process.platform === 'win32' ? process.execPath : 'npm';
    const args = process.platform === 'win32'
      ? [npmCli, 'ls', '--package-lock-only', '--all', '--json']
      : ['ls', '--package-lock-only', '--all', '--json'];
    const result = spawnSync(command, args, {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(output).not.toMatch(/\b(?:invalid|missing):/i);
  });
});
