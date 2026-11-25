// lint-capabilities.test.mjs — Vitest coverage for the capability SSOT lint.
//
// We exercise the script as a CLI (via execFileSync) so the test reflects
// exactly how CI invokes it. The script accepts two override env vars
// (LINT_CAPABILITIES_REGISTRY_PATH, LINT_CAPABILITIES_MIGRATIONS_DIR) so we
// can point it at synthetic fixtures without mutating the real registry or
// migrations tree.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, 'lint-capabilities.mjs');

/**
 * Run the lint script as a child process and capture exit code + stderr.
 * `execFileSync` throws on non-zero exit, so we catch and inspect.
 */
function runLint(env = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT_PATH], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString?.('utf8') ?? '',
      stderr: err.stderr?.toString?.('utf8') ?? '',
    };
  }
}

describe('lint-capabilities script', () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'lint-caps-'));
  });

  afterEach(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it('exits 0 against the real repository state (FE registry + migrations tree)', () => {
    // Default invocation — no env overrides — uses the real SSOT paths.
    const { code, stdout, stderr } = runLint();
    const [summary, ...details] = stderr.split(/\r?\n/);
    let diagnostic = 'unclassified';
    if (summary.startsWith('lint-capabilities: extraction failed: ')) {
      diagnostic = 'extraction failed';
    } else if (summary === 'lint-capabilities: SSOT drift detected between FE and backend.') {
      const keyLine = /^    - ([a-zA-Z]\w*\.[a-z][\w.]*)(?: -> ([a-zA-Z]\w*\.[a-z][\w.]*)  \(canonical missing from backend declarations\))?$/;
      const matches = details.filter((line) => line.startsWith('    - ')).map((line) => line.match(keyLine));
      if (matches.length > 0 && matches.every(Boolean)) {
        const keys = matches.flatMap((match) => match.slice(1).filter(Boolean));
        diagnostic = `capability drift: ${keys.join(', ')}`;
      }
    }
    expect(code, diagnostic).toBe(0);
    expect(stdout).toMatch(/All capabilities aligned/);
  }, 20000);

  it('exits 1 with stderr listing the bogus key when FE registers a string the backend never declares', () => {
    // Synthetic FE registry with a deliberately invented capability that
    // cannot be found in any backend migration.
    const bogusKey = 'totally_invented_surface.read';
    const fakeRegistry = `
// synthetic test registry
export const capabilities = [
  'shipments.read',
  '${bogusKey}',
];
`;
    const fakeRegistryDir = join(workdir, 'src', 'lib', 'seed-raw');
    mkdirSync(fakeRegistryDir, { recursive: true });
    const fakeRegistryPath = join(fakeRegistryDir, 'registry.js');
    writeFileSync(fakeRegistryPath, fakeRegistry, 'utf8');

    // Synthetic backend migration declaring `shipments.read` only — so the
    // bogus key has no canonical match.
    const fakeMigrationsDir = join(workdir, 'supabase', 'migrations');
    mkdirSync(fakeMigrationsDir, { recursive: true });
    writeFileSync(
      join(fakeMigrationsDir, '202601010000_test_seed.sql'),
      `-- synthetic
WITH policy AS (
  SELECT '{"capabilities": [{"key":"shipments.read","label":"Shipments Read"}]}'::jsonb AS value
) SELECT 1;
`,
      'utf8',
    );

    const { code, stderr } = runLint({
      LINT_CAPABILITIES_REGISTRY_PATH: fakeRegistryPath,
      LINT_CAPABILITIES_MIGRATIONS_DIR: fakeMigrationsDir,
    });

    expect(code).toBe(1);
    expect(stderr).toMatch(/SSOT drift detected/);
    expect(stderr).toMatch(/Drift UP/);
    expect(stderr).toContain(bogusKey);
  });

  it('exits 1 with stderr listing backend-only key when backend declares a capability the FE never registers', () => {
    // Synthetic FE registry with one trivial entry; synthetic backend with
    // an extra entry that has no FE counterpart.
    const orphanKey = 'orphan_backend_only.read';
    const fakeRegistry = `
export const capabilities = [
  'shipments.read',
];
`;
    const fakeRegistryDir = join(workdir, 'src', 'lib', 'seed-raw');
    mkdirSync(fakeRegistryDir, { recursive: true });
    const fakeRegistryPath = join(fakeRegistryDir, 'registry.js');
    writeFileSync(fakeRegistryPath, fakeRegistry, 'utf8');

    const fakeMigrationsDir = join(workdir, 'supabase', 'migrations');
    mkdirSync(fakeMigrationsDir, { recursive: true });
    writeFileSync(
      join(fakeMigrationsDir, '202601010000_test_seed.sql'),
      `-- synthetic
WITH policy AS (
  SELECT '{"capabilities": [
    {"key":"shipments.read","label":"Shipments Read"},
    {"key":"${orphanKey}","label":"Orphan"}
  ]}'::jsonb AS value
) SELECT 1;
`,
      'utf8',
    );

    const { code, stderr } = runLint({
      LINT_CAPABILITIES_REGISTRY_PATH: fakeRegistryPath,
      LINT_CAPABILITIES_MIGRATIONS_DIR: fakeMigrationsDir,
    });

    expect(code).toBe(1);
    expect(stderr).toMatch(/Drift DOWN/);
    expect(stderr).toContain(orphanKey);
  });

  it('reports the script-level diagnostic prefix when invoked', () => {
    // A useful sanity check: the failure path always identifies the source
    // tool so operators can grep CI logs for it.
    const fakeRegistryDir = join(workdir, 'src', 'lib', 'seed-raw');
    mkdirSync(fakeRegistryDir, { recursive: true });
    const fakeRegistryPath = join(fakeRegistryDir, 'registry.js');
    writeFileSync(fakeRegistryPath, "export const capabilities = ['drift.example'];\n", 'utf8');

    const fakeMigrationsDir = join(workdir, 'supabase', 'migrations');
    mkdirSync(fakeMigrationsDir, { recursive: true });
    writeFileSync(join(fakeMigrationsDir, 'noop.sql'), '-- empty\n', 'utf8');

    const { code, stderr } = runLint({
      LINT_CAPABILITIES_REGISTRY_PATH: fakeRegistryPath,
      LINT_CAPABILITIES_MIGRATIONS_DIR: fakeMigrationsDir,
    });

    expect(code).toBe(1);
    expect(stderr.startsWith('lint-capabilities:')).toBe(true);
  });
});
