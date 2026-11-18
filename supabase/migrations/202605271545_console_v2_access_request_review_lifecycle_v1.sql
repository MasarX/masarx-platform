--
-- Console V2 Access request review lifecycle.
--
-- Access requests were write-backed through request_capability_grant_v1, but
-- approvers had no Console-facing queue/action to approve or deny the request.
-- This migration exposes a scoped review directory and a typed review RPC that
-- applies approved requests into the existing RBAC role/permission/assignment
-- tables without creating a second authorization model.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605271545_console_v2_access_request_review_lifecycle_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('decision_category', 'Business decision categories for decision_log', 'engineering', 'tier_1', false)
ON CONFLICT (category) DO NOTHING;

WITH decision_category_definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  'access_policy.request_review',
  'Access policy request review',
  'Approver decision for capability grant request lifecycle.',
  2265,
  false,
  'active',
  jsonb_build_object('source', 'console_v2_access_request_review_lifecycle_v1')
FROM decision_category_definition d
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = now();

CREATE OR REPLACE VIEW public.v_capability_grant_request_directory
WITH (security_invoker = true) AS
SELECT
  r.id,
  r.organization_id,
  r.requested_by,
  requested_by.email AS requested_by_email,
  requested_by.full_name AS requested_by_full_name,
  r.target_user_id,
  target_user.email AS target_user_email,
  target_user.full_name AS target_user_full_name,
  r.capability_key,
  r.scope_type,
  r.scope_id,
  r.reason,
  NULLIF(r.metadata->>'duration_hours', '')::integer AS duration_hours,
  r.status,
  r.manual_review_task_id,
  r.decided_by,
  decided_by.email AS decided_by_email,
  decided_by.full_name AS decided_by_full_name,
  r.decided_at,
  r.decision_notes,
  r.correlation_id,
  r.decision_log_id,
  r.settings_resolution_id,
  NULLIF(r.metadata->>'approved_role_id', '')::uuid AS approved_role_id,
  NULLIF(r.metadata->>'approved_permission_id', '')::uuid AS approved_permission_id,
  NULLIF(r.metadata->>'approved_assignment_id', '')::uuid AS approved_assignment_id,
  r.metadata,
  r.created_at,
  r.updated_at
FROM public.capability_grant_requests r
LEFT JOIN public.users requested_by ON requested_by.id = r.requested_by
LEFT JOIN public.users target_user ON target_user.id = r.target_user_id
LEFT JOIN public.users decided_by ON decided_by.id = r.decided_by;

COMMENT ON VIEW public.v_capability_grant_request_directory IS
  'Console V2 Access request review projection. Sources: capability_grant_requests + users; approve/deny writes go through ui_review_capability_grant_request_v1.';

REVOKE ALL ON public.v_capability_grant_request_directory FROM PUBLIC;
REVOKE ALL ON public.v_capability_grant_request_directory FROM anon;
GRANT SELECT ON public.v_capability_grant_request_directory TO authenticated, service_role;

GRANT SELECT ON TABLE public.capability_grant_requests TO authenticated;

DROP POLICY IF EXISTS capability_grant_requests_access_read_policy ON public.capability_grant_requests;
CREATE POLICY capability_grant_requests_access_read_policy
  ON public.capability_grant_requests
  FOR SELECT
  TO authenticated
  USING (
    (organization_id = public.current_user_org_id() OR public.is_platform_user())
    AND public.user_has_capability_v1('access_policy.read', 'tenant', organization_id)
  );

CREATE OR REPLACE FUNCTION public.ui_review_capability_grant_request_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_actor_user_id uuid := auth.uid();
  v_actor_org_id uuid := public.current_user_org_id();
  v_is_service boolean := public.request_role_is_service_v1();
  v_request_id uuid := COALESCE(
    NULLIF(v_args->>'request_id', '')::uuid,
    NULLIF(v_args->>'capability_grant_request_id', '')::uuid
  );
  v_decision_input text := lower(NULLIF(btrim(COALESCE(v_args->>'decision', v_args->>'status')), ''));
  v_decision text;
  v_notes text := NULLIF(btrim(COALESCE(v_args->>'decision_notes', v_args->>'notes', '')), '');
  v_request public.capability_grant_requests%ROWTYPE;
  v_target_org_id uuid;
  v_permission_id uuid;
  v_permission_label text;
  v_role_key text;
  v_role_name text;
  v_role_id uuid;
  v_role_permission_id uuid;
  v_assignment_id uuid;
  v_create_role_result jsonb;
  v_grant_role_result jsonb;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_log_id uuid := gen_random_uuid();
  v_metadata_patch jsonb;
  v_readback jsonb;
BEGIN
  IF v_actor_user_id IS NULL AND NOT v_is_service THEN
    RAISE EXCEPTION 'ui_review_capability_grant_request_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.approve');

  IF v_request_id IS NULL THEN
    RAISE EXCEPTION 'ui_review_capability_grant_request_v1 requires request_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_decision_input IN ('approve', 'approved') THEN
    v_decision := 'approved';
  ELSIF v_decision_input IN ('deny', 'denied', 'reject', 'rejected') THEN
    v_decision := 'denied';
  ELSE
    RAISE EXCEPTION 'ui_review_capability_grant_request_v1 invalid decision %', COALESCE(v_decision_input, '<null>')
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_request
    FROM public.capability_grant_requests
   WHERE id = v_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_review_capability_grant_request_v1 request % not found', v_request_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_is_service
     AND v_actor_org_id IS NOT NULL
     AND v_request.organization_id <> v_actor_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_review_capability_grant_request_v1 request outside tenant scope'
      USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'ui_review_capability_grant_request_v1 request % is already %', v_request_id, v_request.status
      USING ERRCODE = '22023';
  END IF;

  IF v_decision = 'approved' THEN
    IF v_request.target_user_id IS NULL THEN
      RAISE EXCEPTION 'ui_review_capability_grant_request_v1 approved request requires target_user_id'
        USING ERRCODE = '23502';
    END IF;

    SELECT u.organization_id
      INTO v_target_org_id
      FROM public.users u
     WHERE u.id = v_request.target_user_id;

    IF v_target_org_id IS NULL THEN
      RAISE EXCEPTION 'ui_review_capability_grant_request_v1 target user % not found', v_request.target_user_id
        USING ERRCODE = '23503';
    END IF;

    IF v_target_org_id <> v_request.organization_id THEN
      RAISE EXCEPTION 'ui_review_capability_grant_request_v1 target user is outside request organization'
        USING ERRCODE = '42501';
    END IF;

    SELECT lv.id, lv.label
      INTO v_permission_id, v_permission_label
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value = v_request.capability_key
       AND COALESCE(lv.status, 'active') = 'active'
     LIMIT 1;

    IF v_permission_id IS NULL THEN
      RAISE EXCEPTION 'ui_review_capability_grant_request_v1 capability % is not an active RBAC permission', v_request.capability_key
        USING ERRCODE = '23503';
    END IF;

    v_role_key := left(
      'access_request_' || regexp_replace(
        trim(both '_' from regexp_replace(lower(v_request.capability_key), '[^a-z0-9]+', '_', 'g')),
        '_{2,}',
        '_',
        'g'
      ),
      120
    );
    v_role_name := COALESCE(v_permission_label, initcap(replace(v_request.capability_key, '.', ' '))) || ' access request';

    v_create_role_result := public.rbac_create_role_v1(jsonb_build_object(
      'organization_id', v_request.organization_id,
      'key', v_role_key,
      'name', v_role_name,
      'description', 'Auto-created from approved capability grant requests.',
      'is_active', true,
      'metadata', jsonb_build_object(
        'source', 'ui_review_capability_grant_request_v1',
        'capability_key', v_request.capability_key,
        'last_request_id', v_request.id
      )
    ));
    v_role_id := NULLIF(v_create_role_result->>'rbac_role_id', '')::uuid;

    IF v_role_id IS NULL THEN
      RAISE EXCEPTION 'ui_review_capability_grant_request_v1 could not resolve RBAC role for request %', v_request.id
        USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.rbac_roles
       SET is_active = true,
           name = v_role_name,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'source', 'ui_review_capability_grant_request_v1',
             'capability_key', v_request.capability_key,
             'last_request_id', v_request.id
           ),
           updated_at = now()
     WHERE id = v_role_id;

    INSERT INTO public.rbac_role_permissions (
      organization_id, role_id, permission_id, granted_by_user_id, metadata
    ) VALUES (
      v_request.organization_id,
      v_role_id,
      v_permission_id,
      v_actor_user_id,
      jsonb_build_object(
        'source', 'ui_review_capability_grant_request_v1',
        'request_id', v_request.id
      )
    )
    ON CONFLICT (role_id, permission_id) DO UPDATE
      SET granted_by_user_id = COALESCE(public.rbac_role_permissions.granted_by_user_id, EXCLUDED.granted_by_user_id),
          metadata = public.rbac_role_permissions.metadata || EXCLUDED.metadata,
          updated_at = now()
    RETURNING id INTO v_role_permission_id;

    v_grant_role_result := public.rbac_grant_role_v1(jsonb_build_object(
      'organization_id', v_request.organization_id,
      'user_id', v_request.target_user_id,
      'role_id', v_role_id
    ));
    v_assignment_id := NULLIF(v_grant_role_result->>'rbac_user_role_assignment_id', '')::uuid;

    IF v_assignment_id IS NULL THEN
      RAISE EXCEPTION 'ui_review_capability_grant_request_v1 could not resolve RBAC assignment for request %', v_request.id
        USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.rbac_user_role_assignments
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'source', 'ui_review_capability_grant_request_v1',
             'request_id', v_request.id,
             'capability_key', v_request.capability_key
           ),
           updated_at = now()
     WHERE id = v_assignment_id;
  END IF;

  v_metadata_patch := jsonb_strip_nulls(jsonb_build_object(
    'reviewed_via', 'ui_review_capability_grant_request_v1',
    'reviewed_at', now(),
    'review_decision', v_decision,
    'review_correlation_id', v_correlation_id,
    'previous_decision_log_id', v_request.decision_log_id,
    'approved_role_id', v_role_id,
    'approved_permission_id', v_permission_id,
    'approved_role_permission_id', v_role_permission_id,
    'approved_assignment_id', v_assignment_id
  ));

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, decision_reason,
    performed_by_system, correlation_id
  ) VALUES (
    v_decision_log_id,
    v_request.organization_id,
    'access_policy.request_review',
    'capability_grant_request',
    v_request.id,
    'ui_review_capability_grant_request_v1',
    CASE WHEN v_decision = 'denied' THEN 'rejected' ELSE v_decision END,
    jsonb_strip_nulls(jsonb_build_object(
      'capability_key', v_request.capability_key,
      'scope_type', v_request.scope_type,
      'scope_id', v_request.scope_id,
      'target_user_id', v_request.target_user_id,
      'rbac_role_id', v_role_id,
      'rbac_role_permission_id', v_role_permission_id,
      'rbac_user_role_assignment_id', v_assignment_id
    )),
    v_notes,
    'ui_review_capability_grant_request_v1',
    v_correlation_id
  );

  UPDATE public.capability_grant_requests
     SET status = v_decision,
         decided_by = v_actor_user_id,
         decided_at = now(),
         decision_notes = v_notes,
         correlation_id = v_correlation_id::text,
         decision_log_id = v_decision_log_id,
         settings_resolution_id = v_decision_log_id,
         metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata_patch,
         updated_at = now()
   WHERE id = v_request.id;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_request.organization_id,
    CASE WHEN v_decision = 'approved'
      THEN 'capability_grant_request.approved'
      ELSE 'capability_grant_request.denied'
    END,
    'capability_grant_request',
    v_request.id,
    jsonb_strip_nulls(jsonb_build_object(
      'capability_key', v_request.capability_key,
      'target_user_id', v_request.target_user_id,
      'rbac_role_id', v_role_id,
      'rbac_role_permission_id', v_role_permission_id,
      'rbac_user_role_assignment_id', v_assignment_id,
      'decision_notes', v_notes
    )),
    v_correlation_id,
    'completed'
  );

  SELECT to_jsonb(row)
    INTO v_readback
    FROM public.v_capability_grant_request_directory row
   WHERE row.id = v_request.id;

  RETURN jsonb_build_object(
    'ok', true,
    'capability_grant_request_id', v_request.id,
    'status', v_decision,
    'decision', v_decision,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id,
    'decision_log_id', v_decision_log_id,
    'rbac_role_id', v_role_id,
    'rbac_role_permission_id', v_role_permission_id,
    'rbac_user_role_assignment_id', v_assignment_id,
    'request_readback', v_readback
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_review_capability_grant_request_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_review_capability_grant_request_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_review_capability_grant_request_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_review_capability_grant_request_v1(jsonb)
  IS 'Console V2 Access request review RPC. Approves/denies capability_grant_requests and materializes approved grants through canonical RBAC tables. Capability: access_policy.approve.';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_review_capability_grant_request_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$
  SELECT public.ui_review_capability_grant_request_v1(p_args);
$wrapper$;

REVOKE ALL ON FUNCTION api.ui_review_capability_grant_request_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_review_capability_grant_request_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_review_capability_grant_request_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_review_capability_grant_request_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.ui_review_capability_grant_request_v1(jsonb).';

DO $read_registry$
DECLARE
  v_scope record;
  v_current jsonb;
  v_existing_resources jsonb;
  v_filtered jsonb;
  v_resource jsonb := jsonb_build_object(
    'key', 'capability_grant_requests',
    'relation', 'public.v_capability_grant_request_directory',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'access_policy.read',
    'capability_write', 'access_policy.approve',
    'allow_view_relation', true,
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'capability_key', 'column', 'capability_key', 'op', 'ilike'),
      jsonb_build_object('key', 'target_user_id', 'column', 'target_user_id', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'capability_key', 'label', 'Capability', 'mono', true, 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'target_user_email', 'label', 'Target user', 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'requested_by_email', 'label', 'Requested by', 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'scope_type', 'label', 'Scope', 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'status', 'label', 'Status', 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'created_at', 'label', 'Created', 'format', 'datetime', 'sortable', true),
      jsonb_build_object('key', 'decided_at', 'label', 'Decided', 'format', 'datetime', 'sortable', true)
    )
  );
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_existing_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_existing_resources) IS DISTINCT FROM 'array' THEN
      v_existing_resources := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(resource), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_existing_resources) AS resource
     WHERE resource->>'key' <> 'capability_grant_requests';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), true);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose Console V2 Access request review registry resource',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$read_registry$;

SELECT pg_advisory_unlock(hashtext('202605271545_console_v2_access_request_review_lifecycle_v1'));

COMMIT;
