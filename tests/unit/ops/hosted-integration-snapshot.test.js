const fs = require('node:fs');
const { snapshotIntegrationDatabase } = require('../../../scripts/ci-hosted/backend.cjs');

test('the hosted integration snapshot uses the worker clone strategy without forced checkpoints', async () => {
  const disk = jest.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 8 * 2 ** 20, bsize: 1024 });
  const admin = jest.fn()
    .mockResolvedValueOnce('4096')
    .mockResolvedValueOnce(JSON.stringify({
      rolconnlimit: -1,
      rolsuper: false,
      logLevel: 'warning',
      restoreLogging: 'ALTER SYSTEM RESET log_min_messages',
    }))
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('t')
    .mockResolvedValueOnce('debug2')
    .mockResolvedValueOnce(JSON.stringify({ owner: 'fixture_owner', limit: -1, explicitAcl: false }))
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('0')
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('[]')
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('-1')
    .mockResolvedValueOnce('t')
    .mockResolvedValueOnce('warning')
    .mockResolvedValueOnce('42');
  const checked = jest.fn().mockResolvedValue('');

  try {
    await expect(snapshotIntegrationDatabase({
      checked, env: {}, admin, dockerRoot: '.', project: 'fixture',
    })).resolves.toBe('42');
    expect(admin.mock.calls.flat().filter(sql => sql.startsWith('CREATE DATABASE '))).toEqual([
      'CREATE DATABASE integration_pristine TEMPLATE postgres STRATEGY WAL_LOG OWNER fixture_owner CONNECTION LIMIT -1',
    ]);
  } finally {
    disk.mockRestore();
  }
});
