// These helpers require the caller's existing SQL transaction. SQL errors are
// settled by that caller's ROLLBACK, never by a query in an aborted transaction.
const SOURCE = 'provision_demo_accounts_v1';
const CONSTRAINT = 'public.trg_organizations_deferred_onboarding_v1';

async function withOrganizationOnboardingSource(client, action) {
  const previous = await client.query(
    "SELECT current_setting('app.organization_onboarding_source', true) AS source",
  );
  await client.query(
    "SELECT set_config('app.organization_onboarding_source', $1, true)",
    [SOURCE],
  );
  const result = await action();
  await client.query(
    "SELECT set_config('app.organization_onboarding_source', $1, true)",
    [previous.rows[0]?.source || ''],
  );
  return result;
}

async function flushOrganizationOnboarding(client) {
  // Flushes the queued canonical bootstrap once, including ON CONFLICT updates.
  // COMMIT also enforces it if this early readiness check is accidentally omitted.
  await client.query('SET CONSTRAINTS ' + CONSTRAINT + ' IMMEDIATE');
}

async function withOnboardingTransaction(client, action) {
  await client.query('BEGIN');
  try {
    const result = await action();
    await flushOrganizationOnboarding(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Onboarding failed: ${error.message}; rollback could not be confirmed`);
    }
    throw error;
  }
}

module.exports = {
  withOrganizationOnboardingSource,
  flushOrganizationOnboarding,
  withOnboardingTransaction,
};
