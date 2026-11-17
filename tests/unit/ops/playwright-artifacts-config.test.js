const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

test.each(['console', 'portal', 'a11y', 'shared'])(
  'hosted config rejects missing base URL for %s before runtime admission',
  (project) => {
    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js'),
      'test', '--config=playwright.config.ts', '--list', `--project=${project}`,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, ENV_FILE: require('os').devNull, CI: '1', E2E_PROJECTS: project },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('Missing required hosted base URL for the selected E2E projects');
    expect(output).not.toContain('governed_local_e2e_identity_missing');
  },
  20000,
);

describe('Playwright artifacts configuration', () => {
  test('playwright.config.ts configures stable outputs for CI debugging', () => {
    const configPath = path.join(process.cwd(), 'playwright.config.ts');
    const raw = fs.readFileSync(configPath, 'utf8');
    const normalized = raw.replace(/\s+/g, '');

    expect(normalized)
      .toContain('outputDir:process.env.PLAYWRIGHT_TEST_OUTPUT_DIR?.trim()||"test-results"');
    expect(normalized)
      .toContain('["html",{outputFolder:process.env.PLAYWRIGHT_HTML_OUTPUT_DIR||"playwright-report",open:"never"}]');

    for (const configFile of [
      'playwright.config.ts',
      'playwright.landing.config.ts',
      'playwright.fieldops.config.ts',
    ]) {
      const config = fs.readFileSync(path.join(process.cwd(), configFile), 'utf8').replace(/\s+/g, '');
      expect(config).toContain('retries:0');
      expect(config).toContain('trace:"retain-on-failure"');
    }
  });

  test('playwright.config.ts supports env-driven timeout controls for live E2E lanes', () => {
    const configPath = path.join(process.cwd(), 'playwright.config.ts');
    const raw = fs.readFileSync(configPath, 'utf8');
    const normalized = raw.replace(/\s+/g, '');

    expect(normalized).toContain('process.env.E2E_TEST_TIMEOUT_MS');
    expect(normalized).toContain('process.env.E2E_EXPECT_TIMEOUT_MS');
    expect(normalized).toContain('timeout:testTimeoutMs');
    expect(normalized).toContain('timeout:expectTimeoutMs');
    expect(normalized).toContain('constlocalWorkersRaw=Number.parseInt(process.env.E2E_WORKERS??"",10)');
    expect(normalized).toContain('localWorkersRaw>0?localWorkersRaw:isCi?1:4');
    expect(normalized).toContain('workers:localWorkers');
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

  test('strict non-CI loopback mode requires governed runtime admission and suppresses local servers', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'playwright.config.ts'), 'utf8');
    const normalized = raw.replace(/\s+/g, '');

    expect(normalized).toContain('conststrictE2e=isCi||isTruthy(process.env.STRICT_E2E_GATE_ENV)');
    expect(normalized).toContain('isTruthy(process.env.E2E_REQUIRE_BASE_URLS)||strictE2e');
    expect(normalized).toContain('if(requireBaseUrls&&selectedLocalSurfaces.length>0){assertGovernedLocalE2ERuntime');
    expect(normalized).toContain('constshouldStartLocalServers=!requireBaseUrls');
    expect(normalized).toContain('isLoopbackHostname(newURL(origin).hostname)');
    expect(normalized).toContain('forbidOnly:strictE2e');
    expect(normalized).toContain('name:"console"');
    expect(normalized).toContain('name:"a11y"');
    expect(normalized).toContain('name:"shared"');
    expect(normalized).toContain('name:"portal"');
  });

  test('loads ordinary extended loopback without local servers and governs it in strict mode', () => {
    const cli = path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
    const run = (strict) => {
      const env = {
        ...process.env,
        CI: '',
        GITHUB_ACTIONS: '',
        E2E_REQUIRE_BASE_URLS: '',
        STRICT_E2E_GATE_ENV: strict ? '1' : '',
        E2E_PROJECTS: 'console',
        CONSOLE_BASE_URL: 'http://127.0.0.2:3001',
      };
      delete env.JEST_WORKER_ID;
      return spawnSync(process.execPath, [
        cli, 'test', '--config=playwright.config.ts', '--list', '--project=console',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env,
      });
    };
    const ordinary = run(false);
    expect(ordinary.status).toBe(0);
    expect(ordinary.stdout).toContain('[console]');
    const governed = run(true);
    expect(governed.status).not.toBe(0);
    expect(`${governed.stdout}\n${governed.stderr}`).toContain('governed_local_e2e_identity_missing');
  });
});
