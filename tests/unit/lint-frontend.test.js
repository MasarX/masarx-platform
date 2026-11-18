const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const lintScript = path.join(repoRoot, 'scripts', 'tooling', 'lint-frontend.js');
const tmpDir = path.join(repoRoot, 'apps', 'console', 'app', '__lint_tmp__');

function runLintFrontend({ timeoutMs = 30_000, scanRoots = [tmpDir] } = {}) {
  return spawnSync(process.execPath, [lintScript, ...scanRoots], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

function createLintCase(label, ext) {
  const caseId = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(tmpDir, `${caseId}.${ext}`);
  return {
    file,
    cleanup() {
      try {
        fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 });
      } catch {}
    },
  };
}

describe('lint-frontend app-context imports', () => {
  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  });

  test('fails when app-context relative import cannot be resolved', () => {
    const lintCase = createLintCase('app-context-import-bad', 'tsx');
    fs.writeFileSync(
      lintCase.file,
      [
        'import { withConsoleConfig } from "../../../app-context";',
        'export const value = withConsoleConfig;',
      ].join('\n'),
      'utf8'
    );

    try {
      const result = runLintFrontend({ scanRoots: [lintCase.file] });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      expect(result.status).not.toBe(0);
      expect(output).toMatch(/appContextImport/);
      expect(output).toMatch(/Unresolved app-context import/);
    } finally {
      lintCase.cleanup();
    }
  });

  test('passes when app-context relative import resolves correctly', () => {
    const lintCase = createLintCase('app-context-import-good', 'tsx');
    fs.writeFileSync(
      lintCase.file,
      [
        'import { withConsoleConfig } from "../app-context";',
        'export const value = withConsoleConfig;',
      ].join('\n'),
      'utf8'
    );

    try {
      const result = runLintFrontend({ scanRoots: [lintCase.file] });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      expect(result.status).toBe(0);
      expect(output).toMatch(/\[lint:frontend\] OK/);
    } finally {
      lintCase.cleanup();
    }
  });

  test('reports serviceRole violations without hanging (regression)', () => {
    const lintCase = createLintCase('service-role-scan', 'ts');
    fs.writeFileSync(lintCase.file, 'export const role = "service_role";\n', 'utf8');

    try {
      const result = runLintFrontend({ timeoutMs: 20_000, scanRoots: [lintCase.file] });
      expect(result.error).toBeUndefined();

      const output = `${result.stdout || ''}${result.stderr || ''}`;
      expect(result.status).not.toBe(0);
      expect(output).toMatch(/serviceRole/);
      expect(output).toMatch(/service_role/);
    } finally {
      lintCase.cleanup();
    }
  });
  test('ignores only the governed generated MapLibre assets', () => {
    const generated = [
      path.join(repoRoot, 'apps', 'console', 'public', 'maplibre-gl-shared.mjs'),
      path.join(repoRoot, 'apps', 'portal', 'public', 'maplibre-gl-shared.mjs'),
    ];
    for (const file of generated) {
      const result = runLintFrontend({ scanRoots: [file] });
      expect(result.status).toBe(0);
      expect(`${result.stdout || ''}${result.stderr || ''}`).toMatch(/\[lint:frontend\] OK/);
    }

    const nearMiss = createLintCase('maplibre-gl-shared-near-miss', 'mjs');
    fs.writeFileSync(nearMiss.file, 'export const value = Float64Array.from([]);\n', 'utf8');
    try {
      const result = runLintFrontend({ scanRoots: [nearMiss.file] });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      expect(result.status).not.toBe(0);
      expect(output).toMatch(/from/);
    } finally {
      nearMiss.cleanup();
    }
  });


  test('only the server-only OAuth service boundary permits its protected key reference', () => {
    const relative = 'apps/console/app/api/automation-marketplace/oauth/_lib/service-client.ts';
    const file = path.join(repoRoot, relative);
    const source = fs.readFileSync(file, 'utf8');
    expect(source).toMatch(/^import "server-only";/);
    expect(source).toContain('schema: "api"');
    expect(source).not.toContain('NEXT_PUBLIC_');
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/lint/frontend-lint.json'), 'utf8'));
    const permitted = candidate => config.allow.serviceRole.some(pattern => new RegExp(pattern).test(candidate));
    expect(permitted(relative)).toBe(true);
    expect(permitted(relative.replace('service-client.ts', 'routes.ts'))).toBe(false);
    expect(permitted('apps/console/app/automation/marketplace/_components/connection-form.tsx')).toBe(false);
    expect(runLintFrontend({ scanRoots: [file] }).status).toBe(0);
  });

  test('covers the explicit local-mailbox security suite without adding it to ordinary hosted projects', () => {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/lint/frontend-lint.json'), 'utf8'));
    expect(config.playwrightConfigs).toContain('playwright.tenant-invite.config.ts');
    const dedicated = fs.readFileSync(path.join(repoRoot, 'playwright.tenant-invite.config.ts'), 'utf8');
    expect(dedicated).toContain('testMatch: /security\\/tenant-user-invite-takeover\\.spec\\.ts/');
    const npm = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(npm.scripts['test:e2e:tenant-invite']).toContain('-c playwright.tenant-invite.config.ts');
    const result = runLintFrontend({ scanRoots: [] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[lint:frontend] OK');
  });
});
