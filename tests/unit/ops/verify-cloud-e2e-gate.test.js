const fs = require('fs');
const path = require('path');

describe('verify-cloud-e2e-gate', () => {
  test('primes the runner browser path and validates Chromium before the mandatory pack', () => {
    const file = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'scripts',
      'ops',
      'verify-cloud-e2e-gate.js',
    );
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toContain("const { primePlaywrightBrowsersPath } = require('./ci/install-playwright-chromium');");
    expect(body).toContain('primePlaywrightBrowsersPath({ sourceEnv: env });');
    expect(body).toContain("label: 'playwright:install:chromium'");
    expect(body).toContain("path.join('scripts', 'ops', 'ci', 'install-playwright-chromium.js')");
    expect(body).toContain("label: 'verify:cloud:e2e-mandatory-pack'");
  });
});
