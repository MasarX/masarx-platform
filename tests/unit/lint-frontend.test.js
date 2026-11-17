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
});
