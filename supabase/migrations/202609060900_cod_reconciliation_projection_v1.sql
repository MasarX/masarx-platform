-- F808 donor a2d9eae: preserve order-level COD readback, not inferred cash.
-- Raw finalized payment JSON is deliberately kept intact for truthful UI classification.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609060900_cod_reconciliation_projection_v1'));

CREATE VIEW api.cod_reconciliation WITH (security_invoker = true) AS
SELECT s.id, s.organization_id, s.client_id, s.sender_id,
       COALESCE(NULLIF(btrim(s.client_reference_number), ''),
                NULLIF(btrim(s.tracking_number), ''), s.id::text) AS order_reference,
       s.tracking_number,
       s.cod_amount AS original_cod_amount,
       s.cod_currency AS original_cod_currency,
       COALESCE(jsonb_typeof(s.metadata->'delivery_completion') = 'object'
         AND (s.metadata->'delivery_completion') ? 'payment_collection', FALSE)
         AS payment_collection_present,
       s.metadata#>'{delivery_completion,payment_collection}' AS payment_collection,
       s.created_at
FROM public.shipments s
WHERE (
  s.cod_amount > 0
  OR (jsonb_typeof(s.metadata->'delivery_completion') = 'object'
      AND (s.metadata->'delivery_completion') ? 'payment_collection')
)
AND (
  public.request_role_is_service_v1()
  OR (
    public.user_has_resource_capability_v1('shipments', 'read')
    AND (
      public.is_platform_user()
      OR (public.current_user_scope_type() = 'tenant'
          AND s.organization_id = public.current_user_org_id())
      OR (public.current_user_scope_type() = 'client'
          AND s.client_id = public.current_user_client_id())
      OR (public.current_user_scope_type() = 'sender'
          AND s.sender_id = public.current_user_sender_id())
    )
  )
);
COMMENT ON VIEW api.cod_reconciliation IS
  'Scoped shipment COD projection; payment_collection is raw last-finalized truth, not latest-event ranking or remittance.';
REVOKE ALL ON api.cod_reconciliation FROM PUBLIC, anon, authenticated;
GRANT SELECT ON api.cod_reconciliation TO authenticated, service_role;

DO $registry$
DECLARE
  v_row RECORD;
  v_resource JSONB := '{"key":"cod_reconciliation","label":"COD reconciliation","relation":"api.cod_reconciliation","id_column":"id","capability_read":"shipments.read","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"sender_id"},"select":["id","organization_id","client_id","sender_id","order_reference","tracking_number","original_cod_amount","original_cod_currency","payment_collection_present","payment_collection","created_at"],"filters":[{"key":"id","column":"id","op":"eq"},{"key":"client_id","column":"client_id","op":"eq"},{"key":"sender_id","column":"sender_id","op":"eq"},{"key":"tracking_number","column":"tracking_number","op":"ilike"}],"default_sort":{"column":"id","direction":"asc"},"total_strategy":"exact","allow_view_relation":true,"strict_columns":true}'::jsonb;
  v_existing JSONB;
  v_schema JSONB;
  v_matches INTEGER;
  v_next JSONB;
BEGIN
  LOCK TABLE public.settings_versions IN SHARE ROW EXCLUSIVE MODE;
  SELECT s.id AS settings_id, s.settings_version_id, s.category, s.scope_type,
         s.scope_id, s.scope_hash, s.cached_value, sv.value, sv.schema_version,
         sv.effective_from, sv.effective_until, sv.approved_at
    INTO STRICT v_row
    FROM public.settings s JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
     AND sv.category = s.category AND sv.scope_type = s.scope_type
     AND sv.scope_id IS NOT DISTINCT FROM s.scope_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL
   FOR UPDATE OF s, sv;
  IF jsonb_typeof(v_row.value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array'
     OR v_row.cached_value IS DISTINCT FROM v_row.value
     OR v_row.effective_until IS NOT NULL OR v_row.effective_from > clock_timestamp()
     OR v_row.approved_at IS NULL THEN
    RAISE EXCEPTION 'COD registry requires an approved consistent root settings pair';
  END IF;
  SELECT count(*)::int, jsonb_agg(value)->0 INTO v_matches, v_existing
    FROM jsonb_array_elements(v_row.value->'resources')
   WHERE value->>'key' = 'cod_reconciliation';
  IF v_matches > 1 THEN
    RAISE EXCEPTION 'duplicate COD registry resource requires explicit review';
  ELSIF v_matches = 1 THEN
    IF v_existing IS DISTINCT FROM v_resource THEN
      RAISE EXCEPTION 'custom COD registry resource requires explicit review';
    END IF;
    RETURN;
  END IF;
  SELECT schema INTO STRICT v_schema FROM public.schema_registry
   WHERE category = v_row.category AND version = v_row.schema_version;
  IF jsonb_typeof(v_schema) IS DISTINCT FROM 'object'
     OR v_schema->>'type' IS DISTINCT FROM 'object'
     OR v_schema#>>'{properties,resources,type}' IS DISTINCT FROM 'array'
     OR v_schema#>>'{properties,resources,items,type}' IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'COD registry referenced schema has unsupported structural shape';
  END IF;
  -- This is an identity/shape check, NOT JSON Schema validation.
  -- Before native/deployment admission, the exact pointed schema and full proposed
  -- value must pass the existing settings-upsert validator. That governed preflight
  -- is pending; an offline source fixture cannot prove live custom-schema conformance.
  -- Append to the root only. Explicit descendant policies are never rewritten.
  v_next := jsonb_set(v_row.value, '{resources}',
    (v_row.value->'resources') || jsonb_build_array(v_resource), FALSE);
  WITH closed AS (
    UPDATE public.settings_versions
       SET effective_until = GREATEST(clock_timestamp(), effective_from + INTERVAL '1 microsecond'),
           updated_at = clock_timestamp()
     WHERE id = v_row.settings_version_id AND scope_hash = v_row.scope_hash
       AND effective_until IS NULL
    RETURNING id
  ), inserted AS (
    INSERT INTO public.settings_versions(
      id, category, scope_type, scope_id, scope_hash, version, value,
      schema_version, change_reason, approved_at, effective_from)
    SELECT gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id,
      v_row.scope_hash,
      (SELECT COALESCE(MAX(version), 0) + 1 FROM public.settings_versions
        WHERE category = v_row.category AND scope_type = v_row.scope_type
          AND scope_hash = v_row.scope_hash),
      v_next, v_row.schema_version, 'Restore F808 scoped COD order readback',
      clock_timestamp(), clock_timestamp()
    FROM closed RETURNING id, value
  )
  UPDATE public.settings s
     SET settings_version_id = inserted.id, cached_value = inserted.value,
         last_updated = clock_timestamp()
    FROM inserted
   WHERE s.id = v_row.settings_id AND s.settings_version_id = v_row.settings_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COD registry pointer compare-and-swap failed';
  END IF;
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
END;
$registry$;
COMMIT;
