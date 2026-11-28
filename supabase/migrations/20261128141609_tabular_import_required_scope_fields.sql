BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $migration$
DECLARE
  v_definition TEXT := pg_get_functiondef('public.tabular_import_prepare_base_v1(jsonb)'::regprocedure);
  v_prior CONSTANT TEXT := $prior$  IF v_scope_columns ? 'client' AND v_client_id IS NULL THEN
    v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
    IF v_target_field IS NOT NULL AND NOT (v_target_field = ANY(v_required_targets)) THEN
      v_required_targets := array_append(v_required_targets, v_target_field);
    END IF;
  END IF;

  IF v_scope_columns ? 'sender' AND v_sender_id IS NULL THEN
    v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
    IF v_target_field IS NOT NULL AND NOT (v_target_field = ANY(v_required_targets)) THEN
      v_required_targets := array_append(v_required_targets, v_target_field);
    END IF;
  END IF;
$prior$;
  v_replacement CONSTANT TEXT := $replacement$  -- A read scope can use the row's own ID, which the import writer leaves to the database.
  FOR v_target_field IN
    SELECT NULLIF(btrim(v_scope_columns->>scopes.scope_key), '')
    FROM (VALUES (1, 'client', v_client_id), (2, 'sender', v_sender_id))
      AS scopes(ordinal, scope_key, scope_id)
    WHERE scopes.scope_id IS NULL
    ORDER BY scopes.ordinal
  LOOP
    IF v_target_field <> v_id_column AND NOT (v_target_field = ANY(v_required_targets)) THEN
      v_required_targets := array_append(v_required_targets, v_target_field);
    END IF;
  END LOOP;
$replacement$;
BEGIN
  IF strpos(v_definition, v_prior) = 0 THEN
    RAISE EXCEPTION 'Expected scope-derived required fields in public.tabular_import_prepare_base_v1(jsonb)';
  END IF;

  EXECUTE replace(v_definition, v_prior, v_replacement);
END;
$migration$;

COMMIT;
