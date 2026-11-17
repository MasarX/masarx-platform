const fs = require('fs');
const path = require('path');

describe('expo cli undici override', () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageLockPath = path.join(process.cwd(), 'package-lock.json');

  test('pins @expo/cli transitive undici to the patched 6.29.1 release', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));

    expect(packageJson.overrides?.['@expo/cli']?.undici).toBe('6.29.1');
    expect(packageLock.packages?.['node_modules/undici']?.version).toBe('6.29.1');
  });
});
