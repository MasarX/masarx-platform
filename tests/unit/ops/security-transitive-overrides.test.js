const fs = require('fs');
const path = require('path');
const semver = require('semver');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function lockVersions(lock, packageName) {
  const suffix = `/node_modules/${packageName}`;
  return Object.entries(lock.packages)
    .filter(([key, value]) => (key === `node_modules/${packageName}` || key.endsWith(suffix)) && value?.version)
    .map(([key, value]) => ({ key, version: value.version }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('security transitive overrides', () => {
  test('security overrides preserve direct references and compatible parent scopes', () => {
    const root = readJson('package.json');

    for (const [packageName, floor] of [['postcss', '8.5.23'], ['sharp', '0.35.5']]) {
      expect(semver.gte(root.devDependencies[packageName], floor)).toBe(true);
      expect(root.overrides[packageName]).toBe(`$${packageName}`);
    }

    expect(root.overrides['@expo/plist']).toEqual({
      '@xmldom/xmldom': '0.8.15',
    });
    expect(root.overrides['js-yaml@^3.0.0']).toBe('3.15.2');
    expect(root.overrides['js-yaml@^4.0.0']).toBe('4.3.2');
    expect(root.overrides['nx@22.7.12']['smol-toml']).toBe('1.9.0');
    expect(root.overrides['fast-uri']).toBe('3.1.9');
    expect(root.overrides['node-forge']).toBe('1.4.1');
    expect(root.overrides['zod@^4.0.0']).toBe('4.6.7');
    expect(root.overrides).not.toHaveProperty('zod');
    expect(root.overrides.uuid).toBe('11.1.1');
    expect(root.overrides.handlebars).toBe('4.7.10');
    // Root ownership propagates the UUID floor into Expo's workspace-only xcode tree.
    expect(root.devDependencies.xcode).toBe('3.0.1');
    expect(root.overrides['xcode@3.0.1']).toEqual({ uuid: '11.1.1' });
    expect(root.overrides['postcss-selector-parser@^7.0.0']).toBe('7.1.6');
    expect(root.overrides['postcss-nested']['postcss-selector-parser']).toBe('7.1.6');
    expect(root.overrides.tailwindcss['postcss-selector-parser']).toBe('7.1.6');
    expect(root.overrides).not.toHaveProperty('postcss-selector-parser');
    expect(root.overrides['@expo/cli'].compression).toBe('1.8.2');
    expect(root.overrides['source-map-js']).toBe('1.2.2');
    expect(root.overrides['minimatch@3']).toEqual({ 'brace-expansion': '1.1.21' });
    expect(root.overrides['minimatch@5']).toEqual({ 'brace-expansion': '$brace-expansion' });
    expect(root.overrides['minimatch@10']).toEqual({ 'brace-expansion': '5.0.12' });
    expect(root.overrides['@storybook/builder-webpack5@10.6.2']).toEqual({
      'webpack-dev-middleware': '7.4.6',
    });
    expect(root.overrides).not.toHaveProperty('brace-expansion');
    expect(root.overrides).not.toHaveProperty('@xmldom/xmldom');
    expect(root.overrides).not.toHaveProperty('minimatch');
    expect(root.overrides).not.toHaveProperty('@expo/metro-config@54.0.14');
    expect(root.overrides).not.toHaveProperty('@expo/metro-config@54.0.17');
    expect(root.overrides).not.toHaveProperty('next@16.2.11');
    expect(Object.keys(root.overrides).filter((key) => key.startsWith('brace-expansion@'))).toEqual([]);
  });

  test('lock graph contains only patched security dependency versions', () => {
    const lock = readJson('package-lock.json');
    const braceVersions = lockVersions(lock, 'brace-expansion');
    const jsYamlVersions = lockVersions(lock, 'js-yaml');
    const postcssVersions = lockVersions(lock, 'postcss');
    const sharpVersions = lockVersions(lock, 'sharp');
    const smolTomlVersions = lockVersions(lock, 'smol-toml');
    const xmldomVersions = lockVersions(lock, '@xmldom/xmldom');

    expect(braceVersions.length).toBeGreaterThan(0);
    expect(
      braceVersions.every(({ version }) => {
        const major = semver.major(version);
        if (major === 1) return semver.gte(version, '1.1.21');
        if (major === 2) return semver.gte(version, '2.1.7');
        if (major === 3) return semver.gte(version, '3.0.9');
        return semver.gte(version, '5.0.12');
      }),
    ).toBe(true);
    expect(jsYamlVersions.length).toBeGreaterThan(0);
    expect(jsYamlVersions.every(({ version }) => {
      const major = semver.major(version);
      return major === 3 ? semver.gte(version, '3.15.2') : semver.gte(version, '4.3.2');
    })).toBe(true);
    expect(postcssVersions.length).toBeGreaterThan(0);
    expect(postcssVersions.every(({ version }) => semver.gte(version, '8.5.23'))).toBe(true);
    expect(sharpVersions.length).toBeGreaterThan(0);
    expect(sharpVersions.every(({ version }) => semver.gte(version, '0.35.5'))).toBe(true);
    expect(smolTomlVersions.length).toBeGreaterThan(0);
    expect(smolTomlVersions.every(({ version }) => semver.gte(version, '1.9.0'))).toBe(true);
    expect(xmldomVersions.length).toBeGreaterThan(0);
    expect(xmldomVersions.every(({ version }) => {
      if (semver.satisfies(version, '0.8.x')) return semver.gte(version, '0.8.15');
      return semver.gte(version, '0.9.12');
    })).toBe(true);
    expect(lock.packages['node_modules/nx'].version).toBe('22.7.12');
  });

  test.each([
    ['axios', '1.20.0'], ['compression', '1.8.2'], ['follow-redirects', '1.16.2'], ['handlebars', '4.7.10'],
    ['next', '16.4.5'], ['node-forge', '1.4.1'], ['shell-quote', '1.12.0'], ['smol-toml', '1.9.0'], ['source-map-js', '1.2.2'],
    ['undici', '6.29.1'], ['webpack-dev-middleware', '7.4.6'],
  ])('preserves every %s consumer at its supported patched floor', (packageName, floor) => {
    const versions = lockVersions(readJson('package-lock.json'), packageName);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every(({ version }) => semver.gte(version, floor))).toBe(true);
  });

  test('the node-forge security patch satisfies every declared parent range', () => {
    const lock = readJson('package-lock.json');
    const parents = Object.values(lock.packages).filter((entry) => entry.dependencies?.['node-forge']);
    const versions = lockVersions(lock, 'node-forge');
    expect(parents.length).toBeGreaterThan(0);
    expect(versions.length).toBeGreaterThan(0);
    for (const parent of parents) {
      expect(versions.every(({ version }) => semver.satisfies(version, parent.dependencies['node-forge']))).toBe(true);
    }
  });

});
