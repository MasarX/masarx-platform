-- Plan: PLAN-202604-b06-closeout / Step: Fix local admission regressions

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102230_uc078_local_admission_regressions_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Keep label version lineage deletable when source jobs are cleaned up
-------------------------------------------------------------------------------

ALTER TABLE public.label_versions
  DROP CONSTRAINT IF EXISTS label_versions_label_job_fk;

ALTER TABLE public.label_versions
  ADD CONSTRAINT label_versions_label_job_fk
    FOREIGN KEY (label_job_id, organization_id)
    REFERENCES public.label_jobs(id, organization_id)
    ON DELETE SET NULL (label_job_id)
    DEFERRABLE INITIALLY DEFERRED;

-------------------------------------------------------------------------------
-- 2) Resolve caller role from all JWT claim sources before falling back to session_user
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_run_actor_can_read_v1(
  p_organization_id UUID,
  p_route_run_id UUID,
  p_driver_user_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor_user_id UUID := NULL;
  v_scope_type TEXT := COALESCE(public.current_user_scope_type(), 'global');
  v_scope_id UUID := public.current_user_scope_id();
  v_actor_org_id UUID := public.current_user_org_id();
  v_jwt_role TEXT := lower(NULLIF(btrim(COALESCE(auth.jwt() ->> 'role', '')), ''));
  v_claims JSONB := NULLIF(COALESCE(current_setting('request.jwt.claims', true), ''), '')::jsonb;
  v_role_setting TEXT := lower(NULLIF(btrim(COALESCE(current_setting('role', true), '')), ''));
  v_claim_role TEXT := COALESCE(
    v_jwt_role,
    lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '')),
    lower(NULLIF(btrim(COALESCE(v_claims ->> 'role', '')), ''))
  );
  v_is_service BOOLEAN := FALSE;
  v_effective_scope_id UUID := NULL;
  v_effective_driver_user_id UUID := p_driver_user_id;
BEGIN
  IF v_role_setting = 'none' THEN
    v_role_setting := NULL;
  END IF;

  v_is_service := v_claim_role = 'service_role'
    OR (
      v_claim_role IS NULL
      AND v_role_setting = 'service_role'
    )
    OR (
      v_claim_role IS NULL
      AND v_role_setting IS NULL
      AND session_user IN ('postgres', 'supabase_admin', 'service_role')
    );

  IF v_is_service THEN
    RETURN TRUE;
  END IF;

  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  IF v_scope_type <> 'tenant' THEN
    RETURN FALSE;
  END IF;

  IF v_actor_org_id IS NULL OR v_actor_org_id IS DISTINCT FROM p_organization_id THEN
    RETURN FALSE;
  END IF;

  v_effective_scope_id := COALESCE(v_scope_id, v_actor_org_id);

  IF public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_effective_scope_id) THEN
    RETURN TRUE;
  END IF;

  IF NOT public.user_has_resource_capability_v1('routes', 'read', v_scope_type, v_effective_scope_id) THEN
    RETURN FALSE;
  END IF;

  BEGIN
    v_actor_user_id := auth.uid();
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  IF v_actor_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_effective_driver_user_id IS NULL AND p_route_run_id IS NOT NULL THEN
    SELECT COALESCE(
             rr.driver_user_id,
             NULLIF(btrim(COALESCE(rr.metadata #>> '{route_assignment,driver_user_id}', '')), '')::uuid
           )
      INTO v_effective_driver_user_id
      FROM public.route_runs rr
     WHERE rr.id = p_route_run_id
       AND rr.organization_id = p_organization_id
     LIMIT 1;
  END IF;

  IF v_effective_driver_user_id IS NOT NULL AND v_effective_driver_user_id = v_actor_user_id THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.route_run_assignments rra
     WHERE rra.organization_id = p_organization_id
       AND rra.route_run_id = p_route_run_id
       AND rra.driver_user_id = v_actor_user_id
       AND rra.assignment_status IN ('assigned', 'acknowledged', 'accepted')
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) IS
  'Executor-safe route visibility helper. routes.write sees the tenant route inventory; routes.read without write is limited to the driver-owned route assignment. JWT role detection falls back through auth.jwt(), request.jwt.claim.role, request.jwt.claims, then session_user for breakglass sessions only.';

REVOKE ALL ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_run_actor_can_read_v1(UUID, UUID, UUID) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 3) Restore label payload provenance and resolved render policies
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_job label_jobs%ROWTYPE;
  v_payload JSONB;
  v_target RECORD;
  v_policy_row RECORD;
  v_print_row RECORD;
  v_policy JSONB;
  v_print_profile JSONB;
  v_policy_resolution_id UUID := NULL;
  v_print_resolution_id UUID := NULL;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_sender_id UUID := NULL;
  v_shipment_metadata JSONB;
  v_explicit_header_mode TEXT;
  v_effective_header_mode TEXT;
  v_claim_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
BEGIN
  SELECT *
    INTO v_job
    FROM public.label_jobs
   WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Label job % not found', p_job_id;
  END IF;

  IF COALESCE(v_claim_role, lower(current_user)) NOT IN ('service_role', 'edge_label_renderer_role', 'postgres', 'supabase_admin') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
      RAISE EXCEPTION 'Access denied for label job %', p_job_id;
    END IF;
  END IF;

  IF v_job.shipment_id IS NOT NULL THEN
    SELECT to_jsonb(payload)
      INTO v_payload
      FROM shipment_label_payload_v payload
     WHERE payload.shipment_id = v_job.shipment_id
       AND (
             v_job.shipment_box_id IS NULL
             OR payload.shipment_box_id = v_job.shipment_box_id
           )
     ORDER BY payload.box_number NULLS FIRST
     LIMIT 1;
  ELSE
    SELECT *
      INTO v_target
      FROM public.resolve_label_target_payload(
        v_job.target_type,
        v_job.target_id,
        v_job.target_box_id
      )
     LIMIT 1;
    v_payload := COALESCE(v_target.payload, '{}'::jsonb);
  END IF;

  v_payload := COALESCE(v_payload, '{}'::jsonb);
  v_sender_id := NULLIF(v_payload->>'sender_id', '')::uuid;

  IF v_sender_id IS NOT NULL THEN
    v_scope_type := 'sender';
    v_scope_id := v_sender_id;
  ELSIF v_job.client_id IS NOT NULL THEN
    v_scope_type := 'client';
    v_scope_id := v_job.client_id;
  ELSIF v_job.organization_id IS NOT NULL THEN
    v_scope_type := 'tenant';
    v_scope_id := v_job.organization_id;
  ELSE
    v_scope_type := 'global';
    v_scope_id := NULL;
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row('label_render_policy', v_scope_type, v_scope_id)
   LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row('label_render_policy', 'global', NULL)
     LIMIT 1;
  END IF;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    RAISE EXCEPTION 'label_render_policy missing (global) - seed defaults before rendering';
  END IF;

  v_policy := v_policy_row.value;

  v_policy_resolution_id := public.log_settings_resolution(
    p_organization_id := v_job.organization_id,
    p_category := 'label_render_policy',
    p_winning_scope_type := v_policy_row.scope_type,
    p_winning_scope_id := v_policy_row.scope_id,
    p_winning_settings_id := v_policy_row.settings_id,
    p_winning_settings_version_id := v_policy_row.settings_version_id,
    p_winning_version := v_policy_row.version,
    p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'label_job_id', v_job.id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'client_id', v_job.client_id,
      'sender_id', v_sender_id,
      'label_type', v_job.label_type
    )),
    p_merge_notes := NULL
  );

  SELECT *
    INTO v_print_row
    FROM public.resolve_settings_row('label_print_profile', v_scope_type, v_scope_id)
   LIMIT 1;

  IF NOT FOUND OR v_print_row.value IS NULL THEN
    SELECT *
      INTO v_print_row
      FROM public.resolve_settings_row('label_print_profile', 'global', NULL)
     LIMIT 1;
  END IF;

  IF NOT FOUND OR v_print_row.value IS NULL THEN
    RAISE EXCEPTION 'label_print_profile missing (global) - seed defaults before rendering';
  END IF;

  v_print_profile := v_print_row.value;

  v_print_resolution_id := public.log_settings_resolution(
    p_organization_id := v_job.organization_id,
    p_category := 'label_print_profile',
    p_winning_scope_type := v_print_row.scope_type,
    p_winning_scope_id := v_print_row.scope_id,
    p_winning_settings_id := v_print_row.settings_id,
    p_winning_settings_version_id := v_print_row.settings_version_id,
    p_winning_version := v_print_row.version,
    p_scope_path := COALESCE(v_print_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'label_job_id', v_job.id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'client_id', v_job.client_id,
      'sender_id', v_sender_id,
      'label_type', v_job.label_type
    )),
    p_merge_notes := NULL
  );

  v_payload := jsonb_set(v_payload, '{label_render_policy}', v_policy, TRUE);
  v_payload := jsonb_set(v_payload, '{label_print_profile}', v_print_profile, TRUE);
  v_payload := jsonb_set(
    v_payload,
    '{label_render_policy_resolution}',
    jsonb_strip_nulls(jsonb_build_object(
      'settings_resolution_id', v_policy_resolution_id,
      'winning_scope_type', v_policy_row.scope_type,
      'winning_scope_id', v_policy_row.scope_id,
      'version', v_policy_row.version
    )),
    TRUE
  );
  v_payload := jsonb_set(
    v_payload,
    '{label_print_profile_resolution}',
    jsonb_strip_nulls(jsonb_build_object(
      'settings_resolution_id', v_print_resolution_id,
      'winning_scope_type', v_print_row.scope_type,
      'winning_scope_id', v_print_row.scope_id,
      'version', v_print_row.version
    )),
    TRUE
  );

  v_shipment_metadata := v_payload->'shipment_metadata';
  IF v_shipment_metadata IS NULL OR jsonb_typeof(v_shipment_metadata) <> 'object' THEN
    v_shipment_metadata := '{}'::jsonb;
  END IF;

  v_explicit_header_mode := NULLIF(trim(COALESCE(
    v_shipment_metadata->>'header_brand_mode',
    v_shipment_metadata->>'headerBrandMode'
  )), '');

  v_effective_header_mode := v_explicit_header_mode;
  IF v_effective_header_mode IS NULL THEN
    v_effective_header_mode := NULLIF(trim(v_policy->>'header_brand_mode'), '');
  END IF;

  IF v_effective_header_mode IS NULL THEN
    RAISE EXCEPTION 'label_render_policy.header_brand_mode missing (global) - seed defaults before rendering';
  END IF;

  v_shipment_metadata := jsonb_set(v_shipment_metadata, '{header_brand_mode}', to_jsonb(v_effective_header_mode), TRUE);
  v_payload := jsonb_set(v_payload, '{shipment_metadata}', v_shipment_metadata, TRUE);

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'organization_id', v_job.organization_id,
      'client_id', v_job.client_id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'target_type', v_job.target_type,
      'target_id', v_job.target_id,
      'target_box_id', v_job.target_box_id,
      'target_metadata', COALESCE(v_job.target_metadata, '{}'::jsonb),
      'label_type', v_job.label_type,
      'attempts', v_job.attempts,
      'max_attempts', v_job.max_attempts,
      'template', v_job.template_snapshot,
      'renderer_hint', v_job.renderer_hint,
      'retry_state', v_job.retry_state,
      'workflow_run_step_id', NULL
    ),
    'payload', COALESCE(v_payload, '{}'::jsonb)
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Normalize ui_read_registry defaults to the current schema contract
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_key TEXT;
  v_id_column TEXT;
BEGIN
  SELECT s.id AS settings_id,
         s.settings_version_id,
         sv.version,
         sv.value
    INTO v_setting
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_setting.value, '{}'::jsonb);
  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ui_read_registry resources must be an array';
  END IF;

  FOR v_resource IN
    SELECT value
      FROM jsonb_array_elements(v_resources) AS value
  LOOP
    v_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');
    IF v_key IN ('routes', 'route_stops', 'route_plans') THEN
      v_id_column := COALESCE(
        NULLIF(btrim(COALESCE(v_resource->>'id_column', '')), ''),
        NULLIF(btrim(COALESCE(v_resource->>'primary_key', '')), ''),
        'id'
      );
      v_resource := jsonb_set(v_resource, '{id_column}', to_jsonb(v_id_column), TRUE);

      IF v_key = 'routes' THEN
        v_resource := jsonb_set(
          v_resource,
          '{default_sort}',
          jsonb_build_object('column', 'planned_date', 'direction', 'desc'),
          TRUE
        );
      ELSIF v_key = 'route_stops' THEN
        v_resource := jsonb_set(
          v_resource,
          '{default_sort}',
          jsonb_build_object('column', 'sequence_order', 'direction', 'asc'),
          TRUE
        );
      ELSE
        v_resource := jsonb_set(
          v_resource,
          '{default_sort}',
          jsonb_build_object('column', 'planned_date', 'direction', 'desc'),
          TRUE
        );
      END IF;
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

  UPDATE public.settings_versions
     SET value = v_current,
         version = v_setting.version + 1,
         change_reason = 'Normalize ui_read_registry route resources to current schema defaults',
         approved_at = now(),
         effective_from = now()
   WHERE id = v_setting.settings_version_id
     AND v_current IS DISTINCT FROM v_setting.value;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE id = v_setting.settings_id
     AND v_current IS DISTINCT FROM v_setting.value;
END $$;

SELECT pg_advisory_unlock(hashtext('202604102230_uc078_local_admission_regressions_v1'));

COMMIT;
