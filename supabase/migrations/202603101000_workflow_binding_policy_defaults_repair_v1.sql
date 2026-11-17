-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose:
-- - Repair the initial workflow_binding_policy bootstrap so default bindings resolve to
--   the seeded global workflow templates instead of an empty policy.
-- - Prevent client/sender onboarding from materializing empty workflow_binding_policy
--   override rows; they must stay clone-on-write.
-- - Repair tenant rows created from the empty bootstrap and remove empty client/sender
--   rows that were incorrectly materialized.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603101000_workflow_binding_policy_defaults_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.workflow_binding_policy_baseline_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_root_scope_type TEXT := public.get_root_scope_type_key_v1();
  v_bindings JSONB := '{}'::jsonb;
BEGIN
  SELECT COALESCE(
           jsonb_object_agg(seed.binding_key, seed.binding_value ORDER BY seed.binding_key),
           '{}'::jsonb
         )
    INTO v_bindings
    FROM (
      SELECT
        r.binding_key,
        jsonb_strip_nulls(
          jsonb_build_object(
            'label', NULLIF(btrim(COALESCE(r.label, '')), ''),
            'description', NULLIF(btrim(COALESCE(r.description, '')), ''),
            'stages', stage_maps.stage_map
          )
        ) AS binding_value
      FROM public.workflow_binding_registry r
      JOIN LATERAL (
        SELECT COALESCE(
                 jsonb_object_agg(stage_seed.stage_key, stage_seed.stage_value ORDER BY stage_seed.sequence_order, stage_seed.stage_key),
                 '{}'::jsonb
               ) AS stage_map
        FROM (
          SELECT
            s.stage_key,
            s.sequence_order,
            jsonb_strip_nulls(
              jsonb_build_object(
                'enabled', COALESCE(s.is_enabled, TRUE),
                'workflow_template_id', wt.id,
                'inline_progress_steps', NULLIF(step_counts.enabled_step_count, 0),
                'notes', NULLIF(btrim(COALESCE(wt.notes, '')), '')
              )
            ) AS stage_value
          FROM public.workflow_binding_stage_registry s
          JOIN LATERAL (
            SELECT wt.id, wt.notes
            FROM public.workflow_templates wt
            WHERE wt.scope_type = v_root_scope_type
              AND wt.scope_id IS NULL
              AND COALESCE(wt.metadata->>'binding_key', '') = r.binding_key
              AND COALESCE(wt.metadata->>'stage_key', '') = s.stage_key
            ORDER BY wt.version DESC, wt.created_at DESC, wt.id DESC
            LIMIT 1
          ) wt ON TRUE
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::INT AS enabled_step_count
            FROM public.workflow_template_steps wts
            WHERE wts.workflow_template_id = wt.id
              AND COALESCE(wts.enabled, FALSE)
          ) step_counts ON TRUE
          WHERE s.binding_key = r.binding_key
            AND COALESCE(s.is_enabled, TRUE)
        ) stage_seed
      ) stage_maps ON TRUE
      WHERE stage_maps.stage_map <> '{}'::jsonb
        AND COALESCE(r.is_business_affecting, TRUE)
    ) seed;

  RETURN jsonb_build_object('version', 1, 'bindings', COALESCE(v_bindings, '{}'::jsonb));
END;
$function$;

DO $do$
DECLARE
  v_root_scope_type TEXT := public.get_root_scope_type_key_v1();
  v_global_policy JSONB := public.workflow_binding_policy_default_v1();
  v_baseline_policy JSONB := public.workflow_binding_policy_baseline_v1();
  v_scope_key TEXT;
  v_exclude JSONB;
  v_onboarding_policy JSONB;
  v_scope RECORD;
BEGIN
  IF COALESCE(jsonb_typeof(v_baseline_policy->'bindings'), 'null') <> 'object'
     OR (
       SELECT COUNT(*)
       FROM jsonb_object_keys(COALESCE(v_baseline_policy->'bindings', '{}'::jsonb))
     ) = 0 THEN
    RAISE EXCEPTION 'workflow_binding_policy baseline repair found no seeded bindings';
  END IF;

  v_global_policy := COALESCE(
    public.resolve_settings('workflow_binding_policy', v_root_scope_type, NULL),
    public.workflow_binding_policy_default_v1()
  );
  v_global_policy := public.jsonb_deep_merge(v_baseline_policy, v_global_policy);

  PERFORM public.upsert_settings_value_v1(
    'workflow_binding_policy',
    v_root_scope_type,
    NULL,
    v_global_policy,
    1,
    'repair workflow_binding_policy global baseline defaults'
  );

  v_onboarding_policy := COALESCE(
    public.resolve_settings('saas_onboarding_policy', v_root_scope_type, NULL),
    '{}'::jsonb
  );
  IF jsonb_typeof(v_onboarding_policy) IS DISTINCT FROM 'object' THEN
    v_onboarding_policy := '{}'::jsonb;
  END IF;
  v_onboarding_policy := jsonb_set(
    v_onboarding_policy,
    '{workflow_bindings,clone_defaults_for_tenant}',
    'true'::jsonb,
    TRUE
  );

  FOREACH v_scope_key IN ARRAY ARRAY['tenant', 'client', 'sender']
  LOOP
    v_exclude := COALESCE(
      v_onboarding_policy #> ARRAY['materialize_defaults', v_scope_key, 'exclude_categories'],
      '[]'::jsonb
    );
    IF jsonb_typeof(v_exclude) IS DISTINCT FROM 'array' THEN
      v_exclude := '[]'::jsonb;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_exclude) AS item(value)
      WHERE item.value = 'workflow_binding_policy'
    ) THEN
      v_exclude := v_exclude || jsonb_build_array('workflow_binding_policy');
    END IF;
    v_onboarding_policy := jsonb_set(
      v_onboarding_policy,
      ARRAY['materialize_defaults', v_scope_key, 'exclude_categories'],
      v_exclude,
      TRUE
    );
  END LOOP;

  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    v_root_scope_type,
    NULL,
    v_onboarding_policy,
    1,
    'repair saas_onboarding_policy workflow_binding exclusions'
  );

  DELETE FROM public.settings s
  USING public.settings_versions sv
  WHERE s.category = 'workflow_binding_policy'
    AND s.scope_type IN ('client', 'sender')
    AND sv.id = s.settings_version_id
    AND sv.scope_hash = s.scope_hash
    AND COALESCE(s.cached_value, sv.value, public.workflow_binding_policy_default_v1()) = public.workflow_binding_policy_default_v1();

  FOR v_scope IN
    SELECT DISTINCT s.scope_id
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'workflow_binding_policy'
      AND s.scope_type = 'tenant'
      AND s.scope_id IS NOT NULL
      AND COALESCE(s.cached_value, sv.value, public.workflow_binding_policy_default_v1()) = public.workflow_binding_policy_default_v1()
  LOOP
    PERFORM public.bootstrap_workflow_binding_defaults_v1(
      'tenant',
      v_scope.scope_id,
      'repair:workflow_binding_policy_defaults'
    );
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202603101000_workflow_binding_policy_defaults_repair_v1'));
COMMIT;
