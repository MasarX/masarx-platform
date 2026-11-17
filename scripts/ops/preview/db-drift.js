function normalizeFailureOutput(...parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

function hasSchemaMigrationDuplicate(output) {
  const text = String(output || '').toLowerCase();
  return Boolean(
    text.includes('schema_migrations_pkey') ||
    (text.includes('duplicate key value') && text.includes('supabase_migrations.schema_migrations')) ||
    (text.includes('sqlstate 23505') && text.includes('schema_migrations')),
  );
}

function hasMigrationObjectAlreadyExists(output) {
  const text = String(output || '').toLowerCase();
  if (!text) return false;
  const objectAlreadyExists =
    text.includes('already exists (sqlstate 42710)') ||
    /error:\s+(policy|relation|table|type|function|trigger|index|schema|extension)\s+["'][^"']+["'].*already exists/i.test(text) ||
    /error:\s+.*already exists\s+\(sqlstate\s+42710\)/i.test(text);
  if (!objectAlreadyExists) return false;
  return (
    text.includes('applying migration') ||
    text.includes('supabase db push') ||
    text.includes('supabase-cli push') ||
    text.includes('supabase_migrations')
  );
}

function classifyDbPushFailure(output) {
  const normalized = normalizeFailureOutput(output);
  const schemaMigrationDuplicate = hasSchemaMigrationDuplicate(normalized);
  const objectAlreadyExists = hasMigrationObjectAlreadyExists(normalized);

  if (objectAlreadyExists) {
    return {
      failureClass: 'preview-db-drift',
      recoverable: true,
      reason: schemaMigrationDuplicate
        ? 'migration_object_exists_and_history_conflict'
        : 'migration_object_exists',
    };
  }

  if (schemaMigrationDuplicate) {
    return {
      failureClass: 'preview-db-drift',
      recoverable: true,
      reason: 'schema_migrations_duplicate_version',
    };
  }

  return {
    failureClass: '',
    recoverable: false,
    reason: '',
  };
}

function classifyErrorDbPushFailure(error) {
  return classifyDbPushFailure(normalizeFailureOutput(
    error?.output,
    error?.stdout,
    error?.stderr,
    error?.message,
  ));
}

module.exports = {
  normalizeFailureOutput,
  hasSchemaMigrationDuplicate,
  hasMigrationObjectAlreadyExists,
  classifyDbPushFailure,
  classifyErrorDbPushFailure,
};
