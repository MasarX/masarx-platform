BEGIN;

SELECT pg_advisory_lock(hashtext('202603191600_tabular_import_related_node_scope_defaults_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.tabular_import_apply_inherited_scope_defaults_v1(
  p_payload JSONB,
  p_scope_columns JSONB,
  p_primary_payload JSONB,
  p_org_id UUID,
  p_client_id UUID,
  p_sender_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_payload JSONB := CASE
    WHEN jsonb_typeof(p_payload) = 'object' THEN p_payload
    ELSE '{}'::jsonb
  END;
  v_scope_columns JSONB := CASE
    WHEN jsonb_typeof(p_scope_columns) = 'object' THEN p_scope_columns
    ELSE '{}'::jsonb
  END;
  v_primary_payload JSONB := CASE
    WHEN jsonb_typeof(p_primary_payload) = 'object' THEN p_primary_payload
    ELSE '{}'::jsonb
  END;
  v_target_field TEXT;
  v_scope_value JSONB;
  v_existing_value JSONB;
BEGIN
  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'tenant', '')), '');
  IF v_target_field IS NOT NULL THEN
    v_existing_value := v_payload -> v_target_field;
    IF v_existing_value IS NULL
       OR v_existing_value = 'null'::jsonb
       OR (
         jsonb_typeof(v_existing_value) = 'string'
         AND NULLIF(btrim(v_existing_value#>>'{}'), '') IS NULL
       ) THEN
      v_scope_value := v_primary_payload -> v_target_field;
      IF v_scope_value IS NULL
         OR v_scope_value = 'null'::jsonb
         OR (
           jsonb_typeof(v_scope_value) = 'string'
           AND NULLIF(btrim(v_scope_value#>>'{}'), '') IS NULL
         ) THEN
        v_scope_value := CASE WHEN p_org_id IS NOT NULL THEN to_jsonb(p_org_id) ELSE NULL END;
      END IF;

      IF v_scope_value IS NOT NULL
         AND v_scope_value <> 'null'::jsonb
         AND (
           jsonb_typeof(v_scope_value) <> 'string'
           OR NULLIF(btrim(v_scope_value#>>'{}'), '') IS NOT NULL
         ) THEN
        v_payload := jsonb_set(v_payload, ARRAY[v_target_field], v_scope_value, TRUE);
      END IF;
    END IF;
  END IF;

  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
  IF v_target_field IS NOT NULL THEN
    v_existing_value := v_payload -> v_target_field;
    IF v_existing_value IS NULL
       OR v_existing_value = 'null'::jsonb
       OR (
         jsonb_typeof(v_existing_value) = 'string'
         AND NULLIF(btrim(v_existing_value#>>'{}'), '') IS NULL
       ) THEN
      v_scope_value := v_primary_payload -> v_target_field;
      IF v_scope_value IS NULL
         OR v_scope_value = 'null'::jsonb
         OR (
           jsonb_typeof(v_scope_value) = 'string'
           AND NULLIF(btrim(v_scope_value#>>'{}'), '') IS NULL
         ) THEN
        v_scope_value := CASE WHEN p_client_id IS NOT NULL THEN to_jsonb(p_client_id) ELSE NULL END;
      END IF;

      IF v_scope_value IS NOT NULL
         AND v_scope_value <> 'null'::jsonb
         AND (
           jsonb_typeof(v_scope_value) <> 'string'
           OR NULLIF(btrim(v_scope_value#>>'{}'), '') IS NOT NULL
         ) THEN
        v_payload := jsonb_set(v_payload, ARRAY[v_target_field], v_scope_value, TRUE);
      END IF;
    END IF;
  END IF;

  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
  IF v_target_field IS NOT NULL THEN
    v_existing_value := v_payload -> v_target_field;
    IF v_existing_value IS NULL
       OR v_existing_value = 'null'::jsonb
       OR (
         jsonb_typeof(v_existing_value) = 'string'
         AND NULLIF(btrim(v_existing_value#>>'{}'), '') IS NULL
       ) THEN
      v_scope_value := v_primary_payload -> v_target_field;
      IF v_scope_value IS NULL
         OR v_scope_value = 'null'::jsonb
         OR (
           jsonb_typeof(v_scope_value) = 'string'
           AND NULLIF(btrim(v_scope_value#>>'{}'), '') IS NULL
         ) THEN
        v_scope_value := CASE WHEN p_sender_id IS NOT NULL THEN to_jsonb(p_sender_id) ELSE NULL END;
      END IF;

      IF v_scope_value IS NOT NULL
         AND v_scope_value <> 'null'::jsonb
         AND (
           jsonb_typeof(v_scope_value) <> 'string'
           OR NULLIF(btrim(v_scope_value#>>'{}'), '') IS NOT NULL
         ) THEN
        v_payload := jsonb_set(v_payload, ARRAY[v_target_field], v_scope_value, TRUE);
      END IF;
    END IF;
  END IF;

  RETURN v_payload;
END;
$function$;

REVOKE ALL ON FUNCTION public.tabular_import_apply_inherited_scope_defaults_v1(JSONB, JSONB, JSONB, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_apply_inherited_scope_defaults_v1(JSONB, JSONB, JSONB, UUID, UUID, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603191600_tabular_import_related_node_scope_defaults_v1'));

COMMIT;
