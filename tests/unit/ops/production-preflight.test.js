const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse } = require('yaml');
const { checkBackup, latestBackup } = require('../../../scripts/deploy/check-supabase-backup.cjs');

const now = Date.parse('2026-01-02T12:00:00Z');
const backup = {
  id: 1,
  status: 'COMPLETED',
  is_physical_backup: true,
  inserted_at: '2026-01-01T12:00:00.000000+00:00',
};

test('accepts the newest completed restore point on the freshness boundary', () => {
  expect(latestBackup({ backups: [
    { ...backup, status: 'IN_PROGRESS', inserted_at: '2026-01-02T11:59:00Z' },
    backup,
    { ...backup, inserted_at: '2025-12-31T12:00:00Z' },
  ] }, now, 24)).toBe('2026-01-01T12:00:00.000Z');
});

test.each([
  [{}, 'invalid backup inventory'],
  [{ backups: [] }, 'no fresh completed backup'],
  [{ backups: [{ ...backup, status: 'FAILED' }] }, 'no fresh completed backup'],
  [{ backups: [{ ...backup, inserted_at: '2026-01-01T11:59:59Z' }] }, 'no fresh completed backup'],
  [{ backups: [{ ...backup, inserted_at: '2026-02-30T00:00:00Z' }] }, 'invalid completed backup record'],
  [{ backups: [{ ...backup, inserted_at: '2026-01-02T12:00:01Z' }] }, 'invalid completed backup record'],
  [{ backups: [{ ...backup, id: undefined }] }, 'invalid completed backup record'],
])('rejects unusable provider inventory %#', (inventory, failure) => {
  expect(() => latestBackup(inventory, now, 24)).toThrow(failure);
});

test('makes one read-only, target-bound inventory request and fails closed on HTTP errors', async () => {
  const projectRef = 'x'.repeat(20);
  const token = ['generated', 'backup', 'reader'].join('-');
  const request = jest.fn().mockResolvedValue({ ok: false, status: 403 });
  await expect(checkBackup({ projectRef, token, maxAgeHours: 24, now, request })).rejects.toThrow('HTTP 403');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(`https://api.supabase.com/v1/projects/${projectRef}/database/backups`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: expect.any(AbortSignal),
  });
  await expect(checkBackup({ projectRef, token, maxAgeHours: 0, now, request })).rejects.toThrow('invalid backup check configuration');
  expect(request).toHaveBeenCalledTimes(1);
});

const source = readFileSync(resolve(__dirname, '../../../.github/workflows/production-preflight.yml'), 'utf8');
const workflow = parse(source);

test('serializes the prod approval check behind tag verification with no apply step', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs)).toEqual(['verify', 'preflight']);
  const { verify, preflight } = workflow.jobs;
  expect(verify.environment).toBeUndefined();
  expect(verify.steps[1].with).toMatchObject({ ref: '${{ github.ref }}', 'persist-credentials': false });
  expect(verify.steps[2].run).toContain('refs/remotes/origin/main');
  expect(preflight.needs).toBe('verify');
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
])('enforces the pre-approval shell guard for %s', (ref, sha, status) => {
  const result = spawnSync('bash', ['-c', workflow.jobs.verify.steps[0].run], {
    env: { ...process.env, GITHUB_REF: ref, EXPECTED_SHA: sha }, encoding: 'utf8', windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
});
