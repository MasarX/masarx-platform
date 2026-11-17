const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../../scripts/ops/secdef-search-path-repair.js'), 'utf8');
const row = { oid: 42, schema_name: 'public', function_name: 'repair"target', args: 'p_id uuid', original_search_path: '"$user", public', proconfig: ['secret=never-log'], body: 'never-log-body' };

async function run({ rows = [row], failWrite = 0, failAlter = false, failRollback = false, failCommit = false } = {}) {
  const events = [], errors = [];
  let writes = 0;
  const client = {
    query: jest.fn(async sql => {
      events.push({ sql });
      if (sql.startsWith('ALTER') && failAlter) throw new Error('alter failed');
      if (sql === 'ROLLBACK' && failRollback) throw new Error('rollback failed');
      if (sql === 'COMMIT' && failCommit) throw new Error('commit acknowledgement unavailable');
      return { rows: sql.includes('WITH security_definers') ? rows : [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: async () => client, end: jest.fn() };
  const exit = jest.fn();
  await vm.runInNewContext(source, {
    require: id => {
      if (id === 'pg') return { Pool: function () { return pool; } };
      if (id === '../utils/load-env') return { loadEnv() {} };
      if (id === 'node:fs') return { writeFileSync(fd, text) {
        expect(fd).toBe(2);
        if (++writes === failWrite) throw new Error('evidence unavailable');
        events.push({ evidence: JSON.parse(text.slice(text.indexOf('{'))) });
      } };
      throw new Error(`Unexpected dependency: ${id}`);
    },
    process: { env: { DATABASE_URL: 'postgresql://never-log-dsn' }, exit },
    console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
  });
  return { events, errors, client, pool, exit };
}

describe('SECURITY DEFINER pre-repair identity evidence', () => {
  test('emits only original path and identity before ALTER, then committed after COMMIT', async () => {
    const result = await run({ rows: [row, { ...row, oid: 43, args: 'p_id text' }] });
    const plan = result.events.findIndex(event => event.evidence?.event === 'repair-planned');
    const begin = result.events.findIndex(event => event.sql === 'BEGIN');
    const alter = result.events.findIndex(event => event.sql?.startsWith('ALTER'));
    const commit = result.events.findIndex(event => event.sql === 'COMMIT');
    expect(plan).toBeLessThan(alter);
    expect(plan).toBeLessThan(begin);
    expect(result.events[plan].evidence.replacement_search_path).toBe('public, extensions, workflow_handlers, pg_temp');
    expect(result.events[plan].evidence.functions).toEqual([
      { oid: 42, schema_name: 'public', function_name: 'repair"target', args: 'p_id uuid', original_search_path: '"$user", public' },
      { oid: 43, schema_name: 'public', function_name: 'repair"target', args: 'p_id text', original_search_path: '"$user", public' },
    ]);
    expect(result.events[alter].sql).toContain('"repair""target"(p_id uuid)');
    expect(result.events[alter + 1].sql).toContain('"repair""target"(p_id text)');
    expect(result.events[commit + 1].evidence.event).toBe('repair-committed');
    expect(JSON.stringify(result.events.filter(event => event.evidence))).not.toContain('never-log');
    expect(result.exit).not.toHaveBeenCalled();
    expect(result.client.release).toHaveBeenCalledTimes(1);
    expect(result.pool.end).toHaveBeenCalledTimes(1);
    expect(result.events[0].sql).toContain("substring(sp.cfg FROM position('=' IN sp.cfg) + 1) AS original_search_path");
  });
  test('preserves an absent original path explicitly and avoids writes for no drift', async () => {
    const absent = await run({ rows: [{ ...row, original_search_path: null }] });
    expect(absent.events.find(event => event.evidence)?.evidence.functions[0].original_search_path).toBeNull();
    const clean = await run({ rows: [] });
    expect(clean.events).toHaveLength(1);
  });
  test('evidence failure prevents every ALTER', async () => {
    const result = await run({ failWrite: 1 });
    expect(result.events.some(event => event.sql?.startsWith('ALTER'))).toBe(false);
    expect(result.events.some(event => event.sql === 'COMMIT')).toBe(false);
    expect(result.exit).toHaveBeenCalledWith(1);
  });
  test.each([false, true])('failed ALTER records rollback outcome, failedRollback=%s', async failRollback => {
    const result = await run({ failAlter: true, failRollback });
    expect(result.events.some(event => event.evidence?.event === 'repair-committed')).toBe(false);
    expect(result.errors.join('\n')).toContain(`"rollback":"${failRollback ? 'failed' : 'acknowledged'}"`);
    expect(result.exit).toHaveBeenCalledWith(1);
  });
  test('post-COMMIT evidence failure does not claim a rollback undid committed changes', async () => {
    const result = await run({ failWrite: 2 });
    expect(result.events.some(event => event.sql === 'ROLLBACK')).toBe(false);
    expect(result.errors.join('\n')).toContain('"commit_acknowledged":true');
    expect(result.exit).toHaveBeenCalledWith(1);
  });
  test('COMMIT rejection records missing acknowledgement without asserting restoration', async () => {
    const result = await run({ failCommit: true });
    expect(result.events.some(event => event.evidence?.event === 'repair-committed')).toBe(false);
    expect(result.errors.join('\n')).toContain('"commit_acknowledged":false');
    expect(result.errors.join('\n')).toContain('"rollback":"acknowledged"');
    expect(result.exit).toHaveBeenCalledWith(1);
  });
});
