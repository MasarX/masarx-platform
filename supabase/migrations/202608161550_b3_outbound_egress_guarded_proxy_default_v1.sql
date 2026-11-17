BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $do$
DECLARE
  v_root_scope_type TEXT := public.get_root_scope_type_key_v1();
  v_current JSONB := COALESCE(
    public.resolve_settings(
      'outbound_egress_policy',
      public.get_root_scope_type_key_v1(),
      NULL
    ),
    '{}'::jsonb
  );
  v_current_policy JSONB;
  v_reconciled JSONB;
BEGIN
  v_current_policy := CASE
    WHEN jsonb_typeof(v_current->'policy') = 'object' THEN v_current->'policy'
    ELSE '{}'::jsonb
  END;

  v_reconciled := jsonb_set(
    v_current,
    '{policy}',
    v_current_policy || jsonb_build_object('transport_mode', 'guarded_proxy'),
    TRUE
  );

  PERFORM public.upsert_settings_value_v1(
    'outbound_egress_policy',
    v_root_scope_type,
    NULL,
    v_reconciled,
    1,
    'default outbound egress hostname transport to guarded proxy'
  );
END;
$do$;

COMMIT;
