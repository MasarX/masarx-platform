const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260913107000_fieldops_driver_wallet_request_scope_bound_v1.sql',
), 'utf8');
const app = fs.readFileSync(path.resolve(__dirname, '../../../apps/fieldops/App.tsx'), 'utf8');

test('wallet request v2 binds verified actor and organization before unchanged v1 governance', () => {
  expect(migration).toContain('auth.uid() IS DISTINCT FROM p_expected_actor_id');
  expect(migration).toContain('public.current_user_org_id() IS DISTINCT FROM p_expected_organization_id');
  expect(migration.indexOf('driver_wallet_scope_changed')).toBeLessThan(
    migration.indexOf('receipt:=public.ui_request_driver_wallet_withdrawal_v1('));
  expect(migration).toContain("receipt#>>'{wallet,organization_id}' IS DISTINCT FROM p_expected_organization_id::text");
  expect(migration).toContain("receipt#>>'{wallet,driver_user_id}' IS DISTINCT FROM p_expected_actor_id::text");
  expect(migration).toContain('CREATE FUNCTION api.ui_request_driver_wallet_withdrawal_v2(');
  expect(migration).toContain('GRANT EXECUTE ON FUNCTION api.ui_request_driver_wallet_withdrawal_v2');
  expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
  expect(migration).not.toMatch(/INSERT INTO public\.finance_events|UPDATE public\.finance_events|CREATE TABLE/i);
});

test('FieldOps binds request RPC and serializes both wallet KV writes across sign-out', () => {
  const wallet = app.slice(app.indexOf('function WalletCard('), app.indexOf('function MoreScreen('));
  expect(wallet).toContain('"ui_request_driver_wallet_withdrawal_v2"');
  expect(wallet).toContain('p_expected_actor_id: actorId, p_expected_organization_id: organizationId');
  expect(wallet.match(/writeCompletionScopedValue\(cacheStore/g)).toHaveLength(3);
  expect(wallet).toContain('completionReadbackScopeMatches(epoch, actorId, scope)');
  expect(wallet).toContain('if (!current()) return;');
});
