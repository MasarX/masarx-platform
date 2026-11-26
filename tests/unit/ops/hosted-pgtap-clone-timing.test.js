const { timeHostedCloneCommand, dropHostedDatabases } = require('../../../scripts/ci-hosted/backend.cjs');

test('records individual clone durations and preserves command results and failures', async () => {
  const summary = { stages: [] };
  const connectionQuery = 'SELECT 1';
  const firstClone = 'CREATE DATABASE pgtap_worker_1 TEMPLATE postgres';
  const secondClone = 'CREATE DATABASE pgtap_worker_2 TEMPLATE postgres';
  const timeout = new Error('Clone timed out');
  let now = 0;
  const admin = jest.fn()
    .mockResolvedValueOnce('1')
    .mockImplementationOnce(async () => {
      now += 20;
      return 'CREATE DATABASE';
    })
    .mockImplementationOnce(async () => {
      now += 35;
      throw timeout;
    });
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await expect(timeHostedCloneCommand(summary, admin, connectionQuery)).resolves.toBe('1');
    await expect(timeHostedCloneCommand(summary, admin, firstClone)).resolves.toBe('CREATE DATABASE');
    await expect(timeHostedCloneCommand(summary, admin, secondClone)).rejects.toBe(timeout);
  } finally {
    clock.mockRestore();
  }
  expect(admin.mock.calls).toEqual([[connectionQuery], [firstClone], [secondClone]]);
  expect(summary.stages).toMatchObject([
    { name: 'database-clone:pgtap_worker_1', status: 'passed', durationMs: 20 },
    { name: 'database-clone:pgtap_worker_2', status: 'failed', durationMs: 35 },
  ]);
});

test('drops every hosted clone in a separate admin call', async () => {
  const summary = { stages: [] };
  const admin = jest.fn().mockResolvedValue('DROP DATABASE');
  await dropHostedDatabases(summary, admin, ['pgtap_worker_1', 'pgtap_worker_2', 'pgtap_worker_3']);
  expect(admin.mock.calls).toEqual([
    ['DROP DATABASE pgtap_worker_1 WITH (FORCE)'],
    ['DROP DATABASE pgtap_worker_2 WITH (FORCE)'],
    ['DROP DATABASE pgtap_worker_3 WITH (FORCE)'],
  ]);
  expect(summary.stages).toMatchObject([
    { name: 'database-clone-cleanup', status: 'passed' },
    { name: 'database-clone-drop:pgtap_worker_1', status: 'passed' },
    { name: 'database-clone-drop:pgtap_worker_2', status: 'passed' },
    { name: 'database-clone-drop:pgtap_worker_3', status: 'passed' },
  ]);
});

test('fails hosted clone cleanup when an individual drop fails', async () => {
  const summary = { stages: [] };
  const timeout = new Error('Drop timed out');
  const admin = jest.fn().mockResolvedValueOnce('DROP DATABASE').mockRejectedValueOnce(timeout);
  await expect(dropHostedDatabases(summary, admin, ['pgtap_worker_1', 'pgtap_worker_2', 'pgtap_worker_3']))
    .rejects.toBe(timeout);
  expect(admin.mock.calls).toEqual([
    ['DROP DATABASE pgtap_worker_1 WITH (FORCE)'],
    ['DROP DATABASE pgtap_worker_2 WITH (FORCE)'],
  ]);
  expect(summary.stages).toMatchObject([
    { name: 'database-clone-cleanup', status: 'failed' },
    { name: 'database-clone-drop:pgtap_worker_1', status: 'passed' },
    { name: 'database-clone-drop:pgtap_worker_2', status: 'failed' },
  ]);
});
