const fs = require('fs');
const path = require('path');

describe('Playwright artifacts configuration', () => {
  test('playwright.config.ts configures stable outputs for CI debugging', () => {
    const configPath = path.join(process.cwd(), 'playwright.config.ts');
    const raw = fs.readFileSync(configPath, 'utf8');
    const normalized = raw.replace(/\s+/g, '');

    expect(normalized).toContain('outputDir:"test-results"');
    expect(normalized).toContain('["html",{outputFolder:"playwright-report",open:"never"}]');
  });

  test('playwright.config.ts supports env-driven timeout controls for live E2E lanes', () => {
    const configPath = path.join(process.cwd(), 'playwright.config.ts');
    const raw = fs.readFileSync(configPath, 'utf8');
    const normalized = raw.replace(/\s+/g, '');

    expect(normalized).toContain('process.env.E2E_TEST_TIMEOUT_MS');
    expect(normalized).toContain('process.env.E2E_EXPECT_TIMEOUT_MS');
    expect(normalized).toContain('timeout:testTimeoutMs');
    expect(normalized).toContain('timeout:expectTimeoutMs');
  });

  test('playwright.config.ts supports selective project execution for hosted UI gates', () => {
    const configPath = path.join(process.cwd(), 'playwright.config.ts');
    const raw = fs.readFileSync(configPath, 'utf8');
    const normalized = raw.replace(/\s+/g, '');

    expect(normalized).toContain('process.env.E2E_PROJECTS??process.env.E2E_PROJECT');
    expect(normalized).toContain('isProjectSelected("console","a11y","shared")');
    expect(normalized).toContain('isProjectSelected("portal")');
    expect(normalized).toContain('MissingrequiredhostedbaseURLfortheselectedE2Eprojects');
  });
});
