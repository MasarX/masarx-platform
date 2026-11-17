-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Allow marketplace contract settlement batches through canonical settlement policy

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091030_settlement_policy_marketplace_scope_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB := COALESCE(public.resolve_settings_merged('settlement_policy', 'global', NULL::uuid), '{}'::jsonb);
  v_batch_scopes JSONB := '[]'::jsonb;
  v_next JSONB;
BEGIN
  SELECT COALESCE(
           jsonb_agg(to_jsonb(scope_key) ORDER BY scope_key),
           '[]'::jsonb
         )
    INTO v_batch_scopes
    FROM (
      SELECT DISTINCT scope_key
        FROM (
          SELECT jsonb_array_elements_text(
                   CASE
                     WHEN jsonb_typeof(COALESCE(v_current->'batch_scopes', '[]'::jsonb)) = 'array'
                       THEN COALESCE(v_current->'batch_scopes', '[]'::jsonb)
                     ELSE '[]'::jsonb
                   END
                 ) AS scope_key
          UNION ALL
          SELECT 'marketplace_contract'
        ) scope_union
       WHERE NULLIF(btrim(scope_key), '') IS NOT NULL
    ) deduped;

  v_next := jsonb_set(COALESCE(v_current, '{}'::jsonb), '{batch_scopes}', v_batch_scopes, TRUE);
  v_next := jsonb_set(v_next, '{version}', to_jsonb(COALESCE((v_current->>'version')::int, 1)), TRUE);

  PERFORM public.upsert_settings_value_v1(
    p_category := 'settlement_policy',
    p_scope_type := 'global',
    p_scope_id := NULL,
    p_value := v_next,
    p_schema_version := 1,
    p_change_reason := 'Allow marketplace_contract scope in settlement_policy.batch_scopes'
  );
END
$$;

SELECT pg_advisory_unlock(hashtext('202603091030_settlement_policy_marketplace_scope_v1'));
COMMIT;
