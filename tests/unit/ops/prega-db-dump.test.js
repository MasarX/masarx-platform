const {
  buildSupabaseDumpArgs,
  buildPgDumpArgs,
  ensureArgsValid,
  isPgDumpMissingFailure,
  isServerVersionMismatchFailure,
  parseArgs,
  rewriteSslmodeForPgDump,
} = require('../../../scripts/ops/prega-db-dump');

describe('prega-db-dump', () => {
  test('parseArgs reads schema mode and file path', () => {
    const parsed = parseArgs(['--schema', '--file', 'docs/ops/evidence/schema.sql']);
    expect(parsed.schema).toBe(true);
    expect(parsed.data).toBe(false);
    expect(parsed.file).toBe('docs/ops/evidence/schema.sql');
  });

  test('parseArgs reads data mode and lock timeout', () => {
    const parsed = parseArgs(['--data', '--file=data.dump', '--lock-wait-timeout=45s']);
    expect(parsed.data).toBe(true);
    expect(parsed.file).toBe('data.dump');
    expect(parsed.lockWaitTimeout).toBe('45s');
  });

  test('ensureArgsValid requires exactly one mode and file', () => {
    expect(() => ensureArgsValid({ schema: false, data: false, file: 'x' })).toThrow(
      'Select one mode',
    );
    expect(() => ensureArgsValid({ schema: true, data: true, file: 'x' })).toThrow(
      'Select only one mode',
    );
    expect(() => ensureArgsValid({ schema: true, data: false, file: '' })).toThrow(
      'Missing required --file argument',
    );
    expect(() => ensureArgsValid({ schema: true, data: false, file: 'schema.sql' })).not.toThrow();
  });

  test('rewriteSslmodeForPgDump normalizes no-verify to require', () => {
    expect(
      rewriteSslmodeForPgDump((['postgresql',":","/","/",'u',":",'p',"@",'h',":",'5432',"/",'db',"?",'sslmode=no-verify'].join(""))),
    ).toContain('sslmode=require');
  });

  test('buildPgDumpArgs emits schema and data variants', () => {
    const schemaArgs = buildPgDumpArgs({
      dbUrl: 'postgres://x',
      targetFile: 'schema.sql',
      mode: 'schema',
      lockWaitTimeout: '30s',
    });
    expect(schemaArgs).toEqual(expect.arrayContaining(['--schema-only', '--schema=public']));
    expect(schemaArgs).toEqual(expect.arrayContaining(['--lock-wait-timeout=30s']));

    const dataArgs = buildPgDumpArgs({
      dbUrl: 'postgres://x',
      targetFile: 'data.dump',
      mode: 'data',
      lockWaitTimeout: '',
    });
    expect(dataArgs).toEqual(expect.arrayContaining(['--data-only', '--format=custom', '--compress=9']));
  });

  test('buildSupabaseDumpArgs emits schema and data variants', () => {
    const schemaArgs = buildSupabaseDumpArgs({
      dbUrl: 'postgres://x',
      targetFile: 'schema.sql',
      mode: 'schema',
    });
    expect(schemaArgs).toEqual(expect.arrayContaining(['dump', '--db-url', 'postgres://x']));
    expect(schemaArgs).toEqual(expect.arrayContaining(['--schema', 'public']));

    const dataArgs = buildSupabaseDumpArgs({
      dbUrl: 'postgres://x',
      targetFile: 'data.dump',
      mode: 'data',
    });
    expect(dataArgs).toEqual(expect.arrayContaining(['--data-only']));
  });

  test('isPgDumpMissingFailure detects missing pg_dump', () => {
    expect(isPgDumpMissingFailure('spawnSync pg_dump ENOENT')).toBe(true);
    expect(isPgDumpMissingFailure('pg_dump: command not found')).toBe(true);
    expect(isPgDumpMissingFailure('network is unreachable')).toBe(false);
  });

  test('isServerVersionMismatchFailure detects pg_dump/server mismatch signatures', () => {
    expect(
      isServerVersionMismatchFailure('pg_dump: detail: server version: 17.6; pg_dump version: 16.11'),
    ).toBe(true);
    expect(isServerVersionMismatchFailure('pg_dump: error: aborting because of server version mismatch')).toBe(true);
    expect(isServerVersionMismatchFailure('connection refused')).toBe(false);
  });
});
