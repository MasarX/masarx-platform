const { shouldRetrySupabasePushOutput } = require('../../../scripts/ops/supabase-cli-retry');

describe('supabase-cli-retry', () => {
  describe('shouldRetrySupabasePushOutput', () => {
    test('retries on lock timeout', () => {
      expect(shouldRetrySupabasePushOutput('ERROR: canceling statement due to lock timeout')).toBe(true);
    });

    test('retries on SQLSTATE 55P03', () => {
      expect(shouldRetrySupabasePushOutput('pq: SQLSTATE 55P03')).toBe(true);
    });

    test('retries on deadlock', () => {
      expect(shouldRetrySupabasePushOutput('ERROR: deadlock detected (SQLSTATE 40P01)')).toBe(true);
    });

    test('retries on SQLSTATE 57P01 (admin termination)', () => {
      expect(
        shouldRetrySupabasePushOutput('FATAL: terminating connection due to administrator command (SQLSTATE 57P01)'),
      ).toBe(true);
    });

    test('retries on database starting up', () => {
      expect(shouldRetrySupabasePushOutput('FATAL: the database system is starting up (SQLSTATE 57P03)')).toBe(true);
    });

    test('retries on unexpected connection close', () => {
      expect(shouldRetrySupabasePushOutput('server closed the connection unexpectedly')).toBe(true);
    });

    test('retries on pooler max-clients saturation', () => {
      expect(
        shouldRetrySupabasePushOutput(
          'FATAL: MaxClientsInSessionMode: max clients reached - in Session mode max clients are limited to pool_size',
        ),
      ).toBe(true);
    });

    test('does not retry deterministic schema_migrations duplicate key conflict', () => {
      expect(
        shouldRetrySupabasePushOutput(
          'ERROR: duplicate key value violates unique constraint "schema_migrations_pkey" (SQLSTATE 23505)\nINSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)',
        ),
      ).toBe(false);
    });

    test('retries on transient tuple concurrency conflicts', () => {
      expect(
        shouldRetrySupabasePushOutput(
          'ERROR: tuple concurrently updated (SQLSTATE XX000)\nTry rerunning the command with --debug to troubleshoot the error.',
        ),
      ).toBe(true);
    });

    test('does not retry deterministic preview DB object-exists drift', () => {
      expect(
        shouldRetrySupabasePushOutput(
          [
            'Applying migration 202510110008_rls_indexes.sql...',
            'ERROR: policy "organizations_rls_policy" for table "organizations" already exists (SQLSTATE 42710)',
            'ERROR: duplicate key value violates unique constraint "schema_migrations_pkey" (SQLSTATE 23505)',
            'INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)',
          ].join('\n'),
        ),
      ).toBe(false);
    });

    test('does not retry on unrelated unique violations', () => {
      expect(
        shouldRetrySupabasePushOutput('ERROR: duplicate key value violates unique constraint "labels_pkey" (SQLSTATE 23505)'),
      ).toBe(false);
    });

    test('does not retry on non-lock errors', () => {
      expect(shouldRetrySupabasePushOutput('ERROR: syntax error at or near \"FROM\"')).toBe(false);
    });
  });
});
