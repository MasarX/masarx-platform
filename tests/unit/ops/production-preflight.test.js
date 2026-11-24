const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse } = require('yaml');
const { checkBackup } = require('../../../scripts/deploy/check-supabase-backup.cjs');
const { requireProductionPreflight } = require('../../../scripts/deploy/require-production-preflight.cjs');

const bash = process.platform === 'win32' ? resolve(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
const now = Date.parse('2026-01-02T12:00:00Z');
const projectRef = 'x'.repeat(20);
const token = ['generated', 'backup', 'reader'].join('-');
const backupInput = { projectRef, token, maxAgeHours: 24, now };
const backup = {
  id: 1,
  status: 'COMPLETED',
  is_physical_backup: true,
  inserted_at: '2026-01-01T12:00:00.000000+00:00',
};

test('accepts the newest completed restore point inside the freshness limit', async () => {
  const inventory = { backups: [
    { ...backup, status: 'IN_PROGRESS', inserted_at: '2026-01-02T11:59:00Z' },
    { ...backup, inserted_at: '2026-01-01T12:00:01.000000+00:00' },
    { ...backup, inserted_at: '2025-12-31T12:00:00Z' },
  ] };
  const request = jest.fn().mockResolvedValue({ ok: true, json: async () => inventory });
  await expect(checkBackup({ ...backupInput, request })).resolves.toBe('2026-01-01T12:00:01.000Z');
});

test.each([
  ['missing inventory field', {}, 'invalid backup inventory'],
  ['empty inventory', { backups: [] }, 'no fresh completed backup'],
  ['no completed backup', { backups: [{ ...backup, status: 'FAILED' }] }, 'no fresh completed backup'],
  ['stale backup', { backups: [{ ...backup, inserted_at: '2026-01-01T11:59:59Z' }] }, 'no fresh completed backup'],
  ['backup exactly at the freshness limit', { backups: [backup] }, 'no fresh completed backup'],
  ['malformed timestamp', { backups: [{ ...backup, inserted_at: '2026-02-30T00:00:00Z' }] }, 'invalid completed backup record'],
  ['future timestamp', { backups: [{ ...backup, inserted_at: '2026-01-02T12:00:01Z' }] }, 'invalid completed backup record'],
  ['non-UTC offset', { backups: [{ ...backup, inserted_at: '2026-01-01T16:00:00+03:00' }] }, 'invalid completed backup record'],
  ['missing backup ID', { backups: [{ ...backup, id: undefined }] }, 'invalid completed backup record'],
  ['non-boolean backup type', { backups: [{ ...backup, is_physical_backup: 'true' }] }, 'invalid completed backup record'],
])('fails closed on %s', async (_label, inventory, failure) => {
  const request = jest.fn().mockResolvedValue({ ok: true, json: async () => inventory });
  await expect(checkBackup({ ...backupInput, request })).rejects.toThrow(failure);
});

test('makes one read-only, target-bound inventory request and fails closed on HTTP errors', async () => {
  const request = jest.fn().mockResolvedValue({ ok: false, status: 403 });
  await expect(checkBackup({ ...backupInput, request })).rejects.toThrow('HTTP 403');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(`https://api.supabase.com/v1/projects/${projectRef}/database/backups`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
  await expect(checkBackup({ ...backupInput, maxAgeHours: 0, request })).rejects.toThrow('invalid backup check configuration');
  expect(request).toHaveBeenCalledTimes(1);
});

test('fails closed on a rejected backup inventory request', async () => {
  const request = jest.fn().mockRejectedValue(new Error('unavailable'));
  await expect(checkBackup({ ...backupInput, request })).rejects.toThrow('backup inventory request failed');
});

test('fails closed on an unreadable backup inventory response', async () => {
  const json = jest.fn().mockRejectedValue(new SyntaxError('unreadable response'));
  const request = jest.fn().mockResolvedValue({ ok: true, json });
  await expect(checkBackup({ ...backupInput, request })).rejects.toThrow('invalid backup inventory');
});

const admission = { appRun: 'app-run.py', repo: 'example/platform', tag: 'v0.2.0', sha: 'a'.repeat(40) };
const success = { id: 10, head_branch: admission.tag, head_sha: admission.sha, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
const inventoryResponse = runs => JSON.stringify([{ workflow_runs: runs }]);

test('reads the production workflow by exact SHA and returns its latest successful matching run ID', () => {
  const exec = jest.fn().mockReturnValue(JSON.stringify([
    { workflow_runs: [success, { ...success, id: 20, head_branch: 'v0.3.0' }] },
    { workflow_runs: [{ ...success, id: 15 }] },
  ]));
  expect(requireProductionPreflight(admission, exec)).toBe(15);
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec).toHaveBeenCalledWith('python', [
    '-I', admission.appRun, '--org', 'example', '--repo', 'platform', 'gh', 'api', '--paginate', '--slurp',
    `repos/${admission.repo}/actions/workflows/production-preflight.yml/runs?head_sha=${admission.sha}&event=workflow_dispatch&per_page=100`,
  ], expect.any(Object));
});

test.each([
  ['no run', []],
  ['a different tag', [{ ...success, head_branch: 'v0.3.0' }]],
  ['a different SHA', [{ ...success, head_sha: 'b'.repeat(40) }]],
  ['a different event', [{ ...success, event: 'push' }]],
  ['a pending approval', [success, { ...success, id: 11, status: 'waiting', conclusion: null }]],
  ['a cancelled latest run', [success, { ...success, id: 11, conclusion: 'cancelled' }]],
  ['a rejected latest run', [success, { ...success, id: 11, conclusion: 'failure' }]],
])('refuses production apply for %s', (_label, runs) => {
  const exec = jest.fn().mockReturnValue(inventoryResponse(runs));
  expect(() => requireProductionPreflight(admission, exec)).toThrow('must complete successfully');
});

test('refuses production apply when preflight evidence cannot be read', () => {
  const exec = jest.fn(() => { throw new Error('unavailable'); });
  expect(() => requireProductionPreflight(admission, exec)).toThrow('could not read production preflight runs');
  exec.mockReturnValue('{}');
  expect(() => requireProductionPreflight(admission, exec)).toThrow('invalid production preflight run inventory');
});

const runbook = readFileSync(resolve(__dirname, '../../../docs/ops/production-release.md'), 'utf8');
const commands = [...runbook.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)].map(([, block]) => block.split(/\r?\n/));

test('requires the shared exact-SHA CI check before creating the tag', () => {
  const block = commands.find(lines => lines.some(line => line.startsWith('git tag -a ')));
  expect(block).toBeDefined();
  const gate = block.indexOf('bash scripts/deploy/require-ci-gate.sh "$repo" "$RELEASE_SHA" "${app_gh[@]}" || exit 1');
  expect(gate).toBeGreaterThanOrEqual(0);
  expect(gate).toBeLessThan(block.findIndex(line => line.startsWith('git tag -a ')));
});

test('gates all production apply blocks and stops on command failure', () => {
  const applyBlocks = commands.filter(lines => lines.some(line => /\$(SUPABASE|VERCEL|WRANGLER)_CLI/.test(line)));
  expect(applyBlocks).toHaveLength(3);
  for (const lines of applyBlocks) {
    expect(lines[0]).toBe('set -euo pipefail');
    for (const [index, line] of lines.entries()) {
      if (line === '(') expect(lines[index + 1].trim()).toBe('set -euo pipefail');
    }
    const approval = lines.findIndex(line => line.includes('require-production-preflight.cjs'));
    const backupCheck = lines.findIndex(line => line.includes('check-supabase-backup.cjs'));
    const provider = lines.findIndex(line => /\$(SUPABASE|VERCEL|WRANGLER)_CLI/.test(line));
    expect(approval).toBeGreaterThanOrEqual(0);
    expect(lines[approval]).toContain('"$APP_RUN" "$repo" "$tag" "$RELEASE_SHA" || exit 1');
    expect(approval).toBeLessThan(backupCheck);
    expect(backupCheck).toBeLessThan(provider);
  }
});

const source = readFileSync(resolve(__dirname, '../../../.github/workflows/production-preflight.yml'), 'utf8');
const workflow = parse(source);

test('serializes the prod approval check behind tag verification with no apply step', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.env).toMatchObject({ NPM_CONFIG_IGNORE_SCRIPTS: 'true' });
  expect(Object.keys(workflow.jobs)).toEqual(['verify', 'preflight']);
  const { verify, preflight } = workflow.jobs;
  expect(verify.environment).toBeUndefined();
  expect(verify.permissions).toEqual({ contents: 'read', checks: 'read', actions: 'read' });
  expect(verify.steps[1].with).toMatchObject({ ref: '${{ github.ref }}', 'persist-credentials': false });
  expect(verify.steps[2].run).toContain('refs/remotes/origin/main');
  expect(verify.steps[2].run).toContain('bash scripts/deploy/require-ci-gate.sh "$GITHUB_REPOSITORY" "$EXPECTED_SHA"');
  expect(preflight.needs).toBe('verify');
  expect(preflight.permissions).toEqual({});
  expect(preflight.environment).toEqual({ name: 'prod', deployment: false });
  expect(preflight.concurrency).toEqual({ group: 'production-preflight', 'cancel-in-progress': false });
  expect(preflight.steps).toHaveLength(1);
  expect(preflight.steps[0].run).toMatch(/^printf .*\n\s+"\$GITHUB_REF_NAME" "\$EXPECTED_SHA" >> "\$GITHUB_STEP_SUMMARY"\n$/);
  expect(source).not.toMatch(/secrets\.|\b(?:supabase|psql|wrangler|vercel)\b/i);
});

test.each([
  ['refs/tags/v0.2.0', 'a'.repeat(40), 0],
  ['refs/tags/v0.2.0-rc.1', 'a'.repeat(40), 1],
  ['refs/heads/main', 'a'.repeat(40), 1],
  ['refs/tags/v00.2.0', 'a'.repeat(40), 1],
  ['refs/tags/v0.2.0', 'a'.repeat(39), 1],
])('enforces the pre-approval shell guard for %s (case %#)', (ref, sha, status) => {
  const result = spawnSync(bash, ['-c', workflow.jobs.verify.steps[0].run], {
    env: { ...process.env, GITHUB_REF: ref, EXPECTED_SHA: sha }, encoding: 'utf8', windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
});
