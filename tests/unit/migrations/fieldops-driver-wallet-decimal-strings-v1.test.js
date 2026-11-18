const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260913106000_fieldops_driver_wallet_decimal_strings_v1.sql',
), 'utf8');

test('wallet summary preserves exact decimal text without new finance writes or grants', () => {
  expect(migration).toContain('CREATE OR REPLACE FUNCTION public.compute_driver_wallet_summary_v1(');
  for (const marker of [
    "'balance',balance_amount::text",
    "'remitted_payout',remitted_amount::text",
    "'reserved_withdrawal',reserved_amount::text",
    "'available',GREATEST(balance_amount-reserved_amount,0)::text",
    'TO service_role',
  ]) expect(migration).toContain(marker);
  expect(migration).toContain('FROM PUBLIC,anon,authenticated');
  expect(migration).not.toMatch(/CREATE TABLE|INSERT INTO public\.finance_events|GRANT EXECUTE[^;]+TO authenticated/i);
});
