const { disableHostedAutovacuum } = require('../../../scripts/ci-hosted/backend.cjs');

describe('disposable CI database autovacuum', () => {
  const pause = "ALTER SYSTEM SET autovacuum = 'off'";
  const reload = 'SELECT pg_reload_conf()';
  const show = 'SHOW autovacuum';

  test.each(['127.0.0.1', 'localhost'])('disables and verifies autovacuum on %s', async host => {
    const admin = jest.fn().mockResolvedValue('t\n');
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ autovacuum: 'on' }] })
      .mockResolvedValueOnce({ rows: [{ autovacuum: 'off' }] }) };
    const wait = jest.fn();

    await expect(disableHostedAutovacuum(`postgresql://postgres@${host}:15422/postgres`, 15422, admin, db, wait))
      .resolves.toBe('off');

    expect(admin.mock.calls).toEqual([[pause, reload]]);
    expect(db.query.mock.calls).toEqual([[show], [show]]);
    expect(wait.mock.calls).toEqual([[250]]);
  });

  test.each([
    ['postgresql://postgres@db.example.invalid:15422/postgres', 15422],
    ['postgresql://postgres@127.0.0.1:15419/postgres', 15419],
    ['postgresql://postgres@127.0.0.1:15423/postgres', 15422],
    ['postgresql://postgres@127.0.0.1:15422/postgres?host=db.example.invalid', 15422],
    ['postgresql://postgres@127.0.0.1:15422/postgres?hostaddr=192.0.2.1', 15422],
    ['postgresql://postgres@127.0.0.1:15422/postgres?service=synthetic', 15422],
    ['postgresql://postgres@127.0.0.1:15422/postgres?servicefile=synthetic', 15422],
  ])('refuses an unbound target %s', async (url, port) => {
    const admin = jest.fn();
    const db = { query: jest.fn() };

    await expect(disableHostedAutovacuum(url, port, admin, db))
      .rejects.toThrow(new Error('Autovacuum setup requires the disposable CI loopback database on its allocated port'));

    expect(admin.mock.calls).toEqual([]);
    expect(db.query.mock.calls).toEqual([]);
  });

  test('fails before replay if SHOW autovacuum still returns on', async () => {
    const admin = jest.fn().mockResolvedValue('t\n');
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ autovacuum: 'on' }] }) };
    const wait = jest.fn();

    await expect(disableHostedAutovacuum('postgresql://postgres@127.0.0.1:15422/postgres', 15422, admin, db, wait))
      .rejects.toThrow(new Error('Disposable CI database did not report autovacuum=off before migration replay'));

    expect(admin.mock.calls).toEqual([[pause, reload]]);
    expect(db.query.mock.calls).toEqual(Array.from({ length: 20 }, () => [show]));
    expect(wait.mock.calls).toEqual(Array.from({ length: 19 }, () => [250]));
  });
});
