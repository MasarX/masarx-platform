const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260913103000_fieldops_driver_wallet_request_v1.sql',
), 'utf8');

describe('F619 FieldOps driver wallet request', () => {
  test('does not shadow PostgreSQL current_catalog reserved syntax', () => {
    expect(migration).not.toMatch(/\bcurrent_catalog\b/i);
  });

  test('uses only finance and Tasks SSOT truth', () => {
    for (const marker of [
      "account_type='driver_wallet'",
      "event_type='payout'",
      "tt.key='wallet_withdrawal_request'",
      "'available',GREATEST(balance_amount-reserved_amount,0)",
      "AND upper(currency) ~ '^[A-Z]{3}$'",
    ]) expect(migration).toContain(marker);
    expect(migration).not.toMatch(/CREATE TABLE/i);
  });

  test('creates only an actor-locked idempotent request task', () => {
    for (const marker of [
      "assert_capability_v1('finance.withdrawal.request'",
      'pg_advisory_xact_lock',
      "s.category='access_control_policy'",
      "?| ARRAY['*','finance.withdrawal.request']",
      "'fieldops:wallet-withdrawal:'||actor_id||':'||retry_key",
      'FROM public.create_task_system_v1(',
      "'request_only',TRUE",
      'driver_wallet_idempotency_conflict',
    ]) expect(migration).toContain(marker);
    expect(migration).not.toMatch(/INSERT INTO public\.(?:finance_events|settlement_batches|settlement_events)/i);
  });

  test('preserves closeout behavior and narrows wallet privacy', () => {
    expect(migration).toContain('RENAME TO close_route_run_without_wallet_v1');
    expect(migration).toContain("'{route_closeout,wallet_reconciliation}'");
    expect(migration).toContain("resource_type='user' AND resource_id=auth.uid()");
    expect(migration).toContain("user_has_permission_v1('finance.read'");
    expect(migration).not.toMatch(/UPDATE public\.route_runs[\s\S]{0,220}status\s*=/i);
  });
});
