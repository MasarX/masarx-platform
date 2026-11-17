const {
  classifyDbPushFailure,
  hasMigrationObjectAlreadyExists,
  hasSchemaMigrationDuplicate,
} = require('../../../scripts/ops/preview/db-drift');

describe('preview DB drift classification', () => {
  test('classifies object-exists plus migration history conflict as recoverable preview DB drift', () => {
    const output = [
      'Applying migration 202510110008_rls_indexes.sql...',
      'ERROR: policy "organizations_rls_policy" for table "organizations" already exists (SQLSTATE 42710)',
      'ERROR: duplicate key value violates unique constraint "schema_migrations_pkey" (SQLSTATE 23505)',
      'INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)',
    ].join('\n');

    expect(hasMigrationObjectAlreadyExists(output)).toBe(true);
    expect(hasSchemaMigrationDuplicate(output)).toBe(true);
    expect(classifyDbPushFailure(output)).toEqual({
      failureClass: 'preview-db-drift',
      recoverable: true,
      reason: 'migration_object_exists_and_history_conflict',
    });
  });

  test('classifies isolated schema_migrations duplicates as recoverable preview DB drift', () => {
    const output = [
      'ERROR: duplicate key value violates unique constraint "schema_migrations_pkey" (SQLSTATE 23505)',
      'INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)',
    ].join('\n');

    expect(classifyDbPushFailure(output)).toEqual({
      failureClass: 'preview-db-drift',
      recoverable: true,
      reason: 'schema_migrations_duplicate_version',
    });
  });

  test('does not classify unrelated duplicate-key failures as preview drift', () => {
    expect(classifyDbPushFailure('ERROR: duplicate key value violates unique constraint "labels_pkey"')).toEqual({
      failureClass: '',
      recoverable: false,
      reason: '',
    });
  });
});
