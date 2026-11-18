BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(11);

SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema='public'
  AND table_name='route_load_manifest_actions' AND created_at_required AND NOT updated_at_required AND audit_enabled),
  'loading action ledger has creation-only audited table contract');
SELECT ok(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
  AND table_name='route_load_manifest_actions' AND column_name='created_at' AND data_type='timestamp with time zone')
  AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='route_load_manifest_actions' AND column_name='updated_at'),
  'immutable ledger keeps its creation timestamp without invented update time');
SELECT ok((SELECT count(*)=2 FROM pg_trigger WHERE tgrelid='public.route_load_manifest_actions'::REGCLASS
  AND tgname IN ('audit_row_change','audit_truncate_change') AND tgenabled IN ('O','A') AND NOT tgisinternal),
  'canonical row and truncate audit triggers remain enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid='public.route_load_manifest_actions'::REGCLASS)
  AND has_table_privilege('service_role','public.route_load_manifest_actions','SELECT,INSERT')
  AND NOT has_table_privilege('service_role','public.route_load_manifest_actions','UPDATE,DELETE,TRUNCATE')
  AND NOT has_table_privilege('authenticated','public.route_load_manifest_actions','INSERT,UPDATE,DELETE'),
  'RLS and existing append-only role authority remain unchanged');

-- Same leading-column/nonpartial predicate as canonical FK hygiene, scoped to this ledger.
WITH fks AS (
  SELECT con.conkey AS columns FROM pg_constraint con
  WHERE con.conrelid='public.route_load_manifest_actions'::REGCLASS AND con.contype='f'
), missing AS (
  SELECT fk.columns FROM fks fk WHERE NOT EXISTS(
    SELECT 1 FROM pg_index i WHERE i.indrelid='public.route_load_manifest_actions'::REGCLASS
      AND i.indpred IS NULL AND i.indisvalid AND i.indisready
      AND (SELECT array_agg(key ORDER BY ord) FROM unnest(i.indkey) WITH ORDINALITY item(key,ord)
        WHERE ord<=cardinality(fk.columns))=fk.columns)
)
SELECT ok((SELECT count(*)=5 FROM fks) AND NOT EXISTS(SELECT 1 FROM missing),
  'all five actual foreign keys have full leading-column index coverage');
SELECT ok(EXISTS(SELECT 1 FROM public.lookup_definitions WHERE category='route_load_manifest_action'
  AND NOT is_mutable AND approval_policy='tier_1'), 'action category uses canonical governed lookup metadata');
SELECT is((SELECT array_agg(lv.value ORDER BY lv.value)::TEXT FROM public.lookup_values lv
  JOIN public.lookup_definitions ld ON ld.id=lv.lookup_definition_id
  WHERE ld.category='route_load_manifest_action' AND lv.status='active' AND lv.retired_at IS NULL),
  ARRAY['mark_missing','report_discrepancy','undo_missing']::TEXT[]::TEXT, 'exactly the original three actions are active');
SELECT ok(EXISTS(SELECT 1 FROM public.lookup_column_contracts WHERE table_schema='public'
  AND table_name='route_load_manifest_actions' AND column_name='action' AND lookup_category='route_load_manifest_action'
  AND NOT allow_inactive AND cardinality(allowed_values)=3
  AND allowed_values @> ARRAY['mark_missing','undo_missing','report_discrepancy']::TEXT[]),
  'column contract preserves the exact action subset even if the category grows');
SELECT ok(EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.route_load_manifest_actions'::REGCLASS
  AND tgname='trg_lookup_contract_'||substr(md5('public.route_load_manifest_actions'),1,12)
  AND tgfoid='public.enforce_lookup_column_contracts()'::REGPROCEDURE AND tgenabled IN ('O','A') AND NOT tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.route_load_manifest_actions'::REGCLASS
    AND conname='route_load_manifest_actions_action_check'), 'canonical lookup enforcement replaces only the enum check');
SELECT throws_ok($sql$INSERT INTO public.route_load_manifest_actions
  (organization_id,route_run_id,route_stop_id,shipment_box_id,actor_user_id,action,idempotency_key)
  VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'unsupported','hygiene-invalid')$sql$,
  '23514','Invalid lookup value for public.route_load_manifest_actions.action: "unsupported" is not an allowed value for category "route_load_manifest_action"',
  'unsupported action still fails before it can append an event');
SELECT throws_ok($sql$INSERT INTO public.route_load_manifest_actions
  (organization_id,route_run_id,route_stop_id,shipment_box_id,actor_user_id,action,idempotency_key)
  VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'','hygiene-empty')$sql$,
  '23514','Invalid lookup value for public.route_load_manifest_actions.action: empty string is not allowed (category "route_load_manifest_action")',
  'empty action still fails before it can append an event');

SELECT * FROM finish();
ROLLBACK;
