BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE SCHEMA lookup_contract_reapply_fixture;
CREATE TABLE lookup_contract_reapply_fixture.scopes (scope_type TEXT, other_scope TEXT);
INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES ('lookup_contract_reapply_fixture', 'scopes', 'scope_type', 'feature_flag_scope');

SET LOCAL lock_timeout = '0';
SELECT lives_ok(
  $$SELECT public.apply_lookup_column_contracts('lookup_contract_reapply_fixture')$$,
  'applying a contract installs the lookup trigger'
);
SELECT is(current_setting('lock_timeout'), '0', 'applying a contract restores the caller lock timeout');

SELECT lives_ok(
  $$INSERT INTO lookup_contract_reapply_fixture.scopes VALUES (NULL, 'bogus')$$,
  'the unregistered column does not participate in lookup enforcement'
);

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES ('lookup_contract_reapply_fixture', 'scopes', 'other_scope', 'feature_flag_scope');
SELECT lives_ok(
  $$SELECT public.apply_lookup_column_contracts('lookup_contract_reapply_fixture')$$,
  'reapplying contracts updates the existing trigger'
);
SELECT throws_ok(
  $$INSERT INTO lookup_contract_reapply_fixture.scopes VALUES ('bogus', NULL)$$,
  '23514',
  'Invalid lookup value for lookup_contract_reapply_fixture.scopes.scope_type: "bogus" is not an allowed value for category "feature_flag_scope"',
  'the replacement trigger retains enforcement of the original column'
);
SELECT throws_ok(
  $$UPDATE lookup_contract_reapply_fixture.scopes SET other_scope = 'bogus'$$,
  '23514',
  'Invalid lookup value for lookup_contract_reapply_fixture.scopes.other_scope: "bogus" is not an allowed value for category "feature_flag_scope"',
  'the replacement trigger enforces the updated column set'
);

SELECT * FROM finish();
ROLLBACK;
