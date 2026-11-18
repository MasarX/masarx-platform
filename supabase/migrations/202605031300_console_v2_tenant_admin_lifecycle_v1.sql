-- Plan: Console V2 tenant-admin lifecycle closure
-- Step: add canonical organization profile/logo update and tenant user invite contracts.
--
-- These RPCs close the Console V2 gaps where tenant admins could review and
-- operate existing tenants/users but had no typed backend contract for:
--   1. tenant organization profile/logo/default-settings updates
--   2. operator-created tenant user invitations with role assignment

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031300_console_v2_tenant_admin_lifecycle_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

WITH current AS (
  SELECT s.settings_version_id,
         sv.version,
         sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1
),
resources AS (
  SELECT jsonb_agg(
    CASE
      WHEN resource->>'key' = 'organizations' THEN
        resource
        || jsonb_build_object(
          'capability_read', 'organizations.read',
          'capability_write', 'organizations.write',
          'select', jsonb_build_array(
            'id',
            'name',
            'slug',
            'timezone',
            'locale',
            'billing_status',
            'default_settings',
            'created_at',
            'updated_at'
          )
        )
      ELSE resource
    END
    ORDER BY ord
  ) AS resources
  FROM current,
       jsonb_array_elements(COALESCE(current.value->'resources', '[]'::jsonb)) WITH ORDINALITY AS item(resource, ord)
),
updated AS (
  SELECT current.settings_version_id,
         current.version,
         current.value,
         jsonb_set(current.value, '{resources}', COALESCE(resources.resources, '[]'::jsonb), true) AS next_value
    FROM current, resources
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = updated.next_value,
         version = updated.version + 1,
         change_reason = 'Expose organization profile fields for Console V2 tenant lifecycle',
         approved_at = now(),
         effective_from = now()
    FROM updated
   WHERE sv.id = updated.settings_version_id
     AND updated.next_value IS DISTINCT FROM updated.value
   RETURNING sv.id, sv.value
)
UPDATE public.settings s
   SET cached_value = applied.value,
       last_updated = now()
  FROM applied
 WHERE s.category = 'ui_read_registry'
   AND s.scope_type = 'global'
   AND s.scope_id IS NULL
   AND s.settings_version_id = applied.id;

CREATE OR REPLACE FUNCTION public.organization_profile_assert_writer_v1(
  p_organization_id UUID DEFAULT NULL::uuid
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_org_id UUID := public.current_user_org_id();
  v_target_org_id UUID := COALESCE(p_organization_id, v_actor_org_id);
  v_org_name TEXT;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'organization_profile_assert_writer_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('organizations.write');

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'organization_profile_assert_writer_v1 requires organization_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_actor_org_id IS NOT NULL
     AND v_target_org_id <> v_actor_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'organization_profile_assert_writer_v1 organization % outside tenant scope', v_target_org_id
      USING ERRCODE = '42501';
  END IF;

  SELECT o.name INTO v_org_name
    FROM public.organizations o
   WHERE o.id = v_target_org_id;

  IF v_org_name IS NULL THEN
    RAISE EXCEPTION 'organization_profile_assert_writer_v1 organization % not found', v_target_org_id
      USING ERRCODE = '23503';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'actor_user_id', v_actor_user_id,
    'organization_id', v_target_org_id,
    'organization_name', v_org_name
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_update_organization_profile_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_assert JSONB;
  v_actor_user_id UUID;
  v_org_id UUID;
  v_before public.organizations%ROWTYPE;
  v_after public.organizations%ROWTYPE;
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_timezone TEXT := NULLIF(btrim(COALESCE(p_args->>'timezone', '')), '');
  v_locale TEXT := NULLIF(btrim(COALESCE(p_args->>'locale', '')), '');
  v_branding_patch JSONB;
  v_settings_patch JSONB := '{}'::jsonb;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
BEGIN
  v_assert := public.organization_profile_assert_writer_v1(
    NULLIF(p_args->>'organization_id', '')::uuid
  );
  v_actor_user_id := NULLIF(v_assert->>'actor_user_id', '')::uuid;
  v_org_id := NULLIF(v_assert->>'organization_id', '')::uuid;

  SELECT * INTO v_before
    FROM public.organizations
   WHERE id = v_org_id
   FOR UPDATE;

  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_update_organization_profile_v1 organization % not found', v_org_id
      USING ERRCODE = '23503';
  END IF;

  v_branding_patch := jsonb_strip_nulls(jsonb_build_object(
    'logo_url', NULLIF(btrim(COALESCE(p_args->>'logo_url', '')), ''),
    'logo_storage_bucket', NULLIF(btrim(COALESCE(p_args->>'logo_storage_bucket', '')), ''),
    'logo_storage_key', NULLIF(btrim(COALESCE(p_args->>'logo_storage_key', '')), ''),
    'logo_artifact_id', NULLIF(btrim(COALESCE(p_args->>'logo_artifact_id', '')), ''),
    'logo_file_name', NULLIF(btrim(COALESCE(p_args->>'logo_file_name', '')), ''),
    'logo_content_type', NULLIF(btrim(COALESCE(p_args->>'logo_content_type', '')), ''),
    'primary_color', NULLIF(btrim(COALESCE(p_args->>'primary_color', '')), ''),
    'secondary_color', NULLIF(btrim(COALESCE(p_args->>'secondary_color', '')), '')
  ));

  IF v_branding_patch <> '{}'::jsonb THEN
    v_settings_patch := public.deep_merge_jsonb(
      v_settings_patch,
      jsonb_build_object('branding', v_branding_patch)
    );
  END IF;

  IF jsonb_typeof(p_args->'default_settings_patch') = 'object' THEN
    v_settings_patch := public.deep_merge_jsonb(
      v_settings_patch,
      COALESCE(p_args->'default_settings_patch', '{}'::jsonb)
    );
  END IF;

  UPDATE public.organizations
     SET name = COALESCE(v_name, name),
         timezone = COALESCE(v_timezone, timezone),
         locale = COALESCE(v_locale, locale),
         default_settings = CASE
           WHEN v_settings_patch <> '{}'::jsonb THEN
             public.deep_merge_jsonb(COALESCE(default_settings, '{}'::jsonb), v_settings_patch)
           ELSE default_settings
         END,
         updated_at = now()
   WHERE id = v_org_id
   RETURNING * INTO v_after;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system,
    correlation_id, settings_resolution_id
  ) VALUES (
    v_decision_id, v_org_id,
    'organizations.profile_update', 'organization', v_org_id,
    'ui_update_organization_profile_v1', 'updated',
    jsonb_strip_nulls(jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'changed_fields', jsonb_build_object(
        'name', v_name IS NOT NULL AND v_name IS DISTINCT FROM v_before.name,
        'timezone', v_timezone IS NOT NULL AND v_timezone IS DISTINCT FROM v_before.timezone,
        'locale', v_locale IS NOT NULL AND v_locale IS DISTINCT FROM v_before.locale,
        'default_settings', v_settings_patch <> '{}'::jsonb
      ),
      'branding_patch', NULLIF(v_branding_patch, '{}'::jsonb)
    )),
    'ui_update_organization_profile_v1', v_correlation_id, v_decision_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload,
    correlation_id, status
  ) VALUES (
    v_org_id, 'organization.profile_updated', 'organization', v_org_id,
    jsonb_strip_nulls(jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'branding', v_after.default_settings->'branding'
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'organization_id', v_org_id,
    'name', v_after.name,
    'timezone', v_after.timezone,
    'locale', v_after.locale,
    'billing_status', v_after.billing_status,
    'branding', v_after.default_settings->'branding',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_user_invite_assert_operator_v1(
  p_organization_id UUID DEFAULT NULL::uuid
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_org_id UUID := public.current_user_org_id();
  v_target_org_id UUID := COALESCE(p_organization_id, v_actor_org_id);
  v_org_name TEXT;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_assert_operator_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.manage');

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_assert_operator_v1 requires organization_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_actor_org_id IS NOT NULL
     AND v_target_org_id <> v_actor_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'tenant_user_invite_assert_operator_v1 organization % outside tenant scope', v_target_org_id
      USING ERRCODE = '42501';
  END IF;

  SELECT o.name INTO v_org_name
    FROM public.organizations o
   WHERE o.id = v_target_org_id;

  IF v_org_name IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_assert_operator_v1 organization % not found', v_target_org_id
      USING ERRCODE = '23503';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'actor_user_id', v_actor_user_id,
    'organization_id', v_target_org_id,
    'organization_name', v_org_name
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_list_tenant_invitable_roles_v1(
  p_organization_id UUID DEFAULT NULL::uuid
)
RETURNS TABLE (
  role_id UUID,
  organization_id UUID,
  role_key TEXT,
  name TEXT,
  description TEXT,
  is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_assert JSONB;
  v_org_id UUID;
BEGIN
  v_assert := public.tenant_user_invite_assert_operator_v1(p_organization_id);
  v_org_id := NULLIF(v_assert->>'organization_id', '')::uuid;

  RETURN QUERY
  SELECT
    r.id AS role_id,
    r.organization_id,
    r.key AS role_key,
    r.name,
    r.description,
    r.is_active
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org_id
    AND COALESCE(r.is_active, TRUE) IS TRUE
  ORDER BY r.key;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_user_invite_apply_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_actor_user_id UUID := COALESCE(NULLIF(p_args->>'actor_user_id', '')::uuid, auth.uid());
  v_actor_org_id UUID;
  v_target_org_id UUID := NULLIF(p_args->>'organization_id', '')::uuid;
  v_email TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'email', '')), ''));
  v_full_name TEXT := NULLIF(btrim(COALESCE(p_args->>'full_name', '')), '');
  v_role_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'role_key', '')), ''));
  v_access_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_args->>'access_scope_type'), ''), 'tenant'));
  v_access_scope_id UUID := NULLIF(p_args->>'access_scope_id', '')::uuid;
  v_auth_user_id UUID := NULLIF(p_args->>'auth_user_id', '')::uuid;
  v_invite_email_sent BOOLEAN := COALESCE((p_args->>'invite_email_sent')::boolean, false);
  v_invite_email_requested BOOLEAN := COALESCE((p_args->>'send_invite_email_requested')::boolean, false);
  v_preflight_only BOOLEAN := COALESCE((p_args->>'preflight_only')::boolean, false);
  v_existing_user_id UUID;
  v_existing_user_org_id UUID;
  v_target_user_id UUID;
  v_user_type TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'user_type', '')), ''));
  v_default_user_type TEXT;
  v_role_id UUID;
  v_assignment_id UUID;
  v_idempotent BOOLEAN := FALSE;
  v_status TEXT;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires actor_user_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT u.organization_id INTO v_actor_org_id
    FROM public.users u
   WHERE u.id = v_actor_user_id;

  IF v_actor_org_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 actor user % not found', v_actor_user_id
      USING ERRCODE = '23503';
  END IF;

  v_target_org_id := COALESCE(v_target_org_id, v_actor_org_id);

  IF NOT v_is_service THEN
    PERFORM public.assert_capability_v1('users.manage');
    IF v_actor_org_id IS NOT NULL
       AND v_target_org_id <> v_actor_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'tenant_user_invite_apply_v1 organization % outside tenant scope', v_target_org_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_target_org_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires organization_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires email'
      USING ERRCODE = '23502';
  END IF;

  IF v_role_key IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires role_key'
      USING ERRCODE = '23502';
  END IF;

  SELECT lv.value INTO v_default_user_type
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'user_type'
     AND lv.status = 'active'
   ORDER BY COALESCE(lv.is_default, FALSE) DESC, COALESCE(lv.sort_order, 0), lv.value
   LIMIT 1;

  IF v_user_type IS NULL THEN
    SELECT lv.value INTO v_user_type
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'user_type'
       AND lv.status = 'active'
       AND lv.value = v_role_key
     LIMIT 1;

    v_user_type := COALESCE(v_user_type, v_default_user_type);
  ELSIF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'user_type'
       AND lv.status = 'active'
       AND lv.value = v_user_type
  ) THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 unsupported user_type %', v_user_type
      USING ERRCODE = '23514';
  END IF;

  IF v_user_type IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 user_type lookup has no active default'
      USING ERRCODE = '23514';
  END IF;

  IF v_access_scope_type NOT IN ('platform', 'tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 unsupported access_scope_type %', v_access_scope_type
      USING ERRCODE = '23514';
  END IF;

  IF v_access_scope_type IN ('platform', 'tenant') THEN
    v_access_scope_id := NULL;
  ELSIF v_access_scope_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires access_scope_id for %', v_access_scope_type
      USING ERRCODE = '23502';
  END IF;

  SELECT u.id, u.organization_id
    INTO v_existing_user_id, v_existing_user_org_id
    FROM public.users u
   WHERE lower(u.email) = v_email
   LIMIT 1;

  IF v_existing_user_id IS NOT NULL AND v_existing_user_org_id IS DISTINCT FROM v_target_org_id THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 email % already belongs to another organization', v_email
      USING ERRCODE = '23505';
  END IF;

  IF v_existing_user_id IS NULL AND v_auth_user_id IS NOT NULL THEN
    SELECT u.id, u.organization_id
      INTO v_existing_user_id, v_existing_user_org_id
      FROM public.users u
     WHERE u.id = v_auth_user_id
     LIMIT 1;

    IF v_existing_user_id IS NOT NULL AND v_existing_user_org_id IS DISTINCT FROM v_target_org_id THEN
      RAISE EXCEPTION 'tenant_user_invite_apply_v1 auth user % already belongs to another organization', v_auth_user_id
        USING ERRCODE = '23505';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.rbac_roles r
     WHERE r.organization_id = v_target_org_id
       AND r.key = v_role_key
       AND r.is_active = TRUE
  ) AND NOT EXISTS (
    SELECT 1
      FROM public.rbac_role_templates t
     WHERE t.key = v_role_key
       AND t.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 role_key % not found or provisionable for org %', v_role_key, v_target_org_id
      USING ERRCODE = '23503';
  END IF;

  IF v_preflight_only THEN
    RETURN jsonb_build_object(
      'ok', true,
      'preflight_only', true,
      'organization_id', v_target_org_id,
      'role_key', v_role_key,
      'existing_user_id', v_existing_user_id
    );
  END IF;

  v_target_user_id := COALESCE(v_existing_user_id, v_auth_user_id);

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 requires auth_user_id for a new user'
      USING ERRCODE = '23502';
  END IF;

  v_status := CASE WHEN v_invite_email_sent OR v_invite_email_requested THEN 'invited' ELSE 'active' END;
  v_full_name := COALESCE(v_full_name, v_email);

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  ) VALUES (
    v_target_user_id,
    v_target_org_id,
    v_email,
    v_full_name,
    v_user_type,
    v_status,
    v_access_scope_type,
    v_access_scope_id
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      full_name = COALESCE(NULLIF(public.users.full_name, ''), EXCLUDED.full_name)
  RETURNING id INTO v_target_user_id;

  PERFORM public.provision_rbac_roles_from_templates_v1(
    v_target_org_id,
    ARRAY[v_role_key],
    NULL
  );

  SELECT r.id INTO v_role_id
    FROM public.rbac_roles r
   WHERE r.organization_id = v_target_org_id
     AND r.key = v_role_key
   LIMIT 1;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_apply_v1 role_key % not found in org %', v_role_key, v_target_org_id
      USING ERRCODE = '23503';
  END IF;

  SELECT a.id INTO v_assignment_id
    FROM public.rbac_user_role_assignments a
   WHERE a.organization_id = v_target_org_id
     AND a.user_id = v_target_user_id
     AND a.role_id = v_role_id
     AND a.revoked_at IS NULL
   LIMIT 1;

  IF v_assignment_id IS NULL THEN
    INSERT INTO public.rbac_user_role_assignments (
      organization_id,
      user_id,
      role_id,
      assigned_by_user_id,
      metadata
    ) VALUES (
      v_target_org_id,
      v_target_user_id,
      v_role_id,
      v_actor_user_id,
      jsonb_strip_nulls(jsonb_build_object(
        'source', 'tenant_user_invite_apply_v1',
        'invite_email_sent', v_invite_email_sent,
        'send_invite_email_requested', v_invite_email_requested,
        'invite_redirect_to', NULLIF(p_args->>'invite_redirect_to', '')
      ))
    )
    RETURNING id INTO v_assignment_id;
  ELSE
    v_idempotent := TRUE;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system,
    correlation_id, settings_resolution_id
  ) VALUES (
    v_decision_id, v_target_org_id,
    'users.invite', 'user', v_target_user_id,
    'tenant_user_invite_apply_v1',
    CASE WHEN v_idempotent THEN 'idempotent_existing_assignment' ELSE 'invited' END,
    jsonb_strip_nulls(jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'email', v_email,
      'role_key', v_role_key,
      'user_type', v_user_type,
      'access_scope_type', v_access_scope_type,
      'access_scope_id', v_access_scope_id,
      'invite_email_sent', v_invite_email_sent,
      'send_invite_email_requested', v_invite_email_requested,
      'idempotent_no_op', v_idempotent
    )),
    'tenant_user_invite_apply_v1', v_correlation_id, v_decision_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload,
    correlation_id, status
  ) VALUES (
    v_target_org_id, 'user.invited', 'user', v_target_user_id,
    jsonb_strip_nulls(jsonb_build_object(
      'actor_user_id', v_actor_user_id,
      'email', v_email,
      'role_key', v_role_key,
      'user_type', v_user_type,
      'invite_email_sent', v_invite_email_sent,
      'send_invite_email_requested', v_invite_email_requested,
      'idempotent_no_op', v_idempotent
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'user_id', v_target_user_id,
    'organization_id', v_target_org_id,
    'email', v_email,
    'full_name', v_full_name,
    'user_type', v_user_type,
    'role_key', v_role_key,
    'status', v_status,
    'access_scope_type', v_access_scope_type,
    'access_scope_id', v_access_scope_id,
    'rbac_user_role_assignment_id', v_assignment_id,
    'invite_email_sent', v_invite_email_sent,
    'idempotent_no_op', v_idempotent,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION api.organization_profile_assert_writer_v1(
  p_organization_id UUID DEFAULT NULL::uuid
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.organization_profile_assert_writer_v1($1);
$function$;

CREATE OR REPLACE FUNCTION api.ui_update_organization_profile_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_update_organization_profile_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.register_artifact_v1(
  p_artifact JSONB
)
RETURNS TABLE (
  artifact_id UUID,
  created BOOLEAN
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.register_artifact_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.tenant_user_invite_assert_operator_v1(
  p_organization_id UUID DEFAULT NULL::uuid
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.tenant_user_invite_assert_operator_v1($1);
$function$;

CREATE OR REPLACE FUNCTION api.ui_list_tenant_invitable_roles_v1(
  p_organization_id UUID DEFAULT NULL::uuid
)
RETURNS TABLE (
  role_id UUID,
  organization_id UUID,
  role_key TEXT,
  name TEXT,
  description TEXT,
  is_active BOOLEAN
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.ui_list_tenant_invitable_roles_v1($1);
$function$;

CREATE OR REPLACE FUNCTION api.tenant_user_invite_apply_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.tenant_user_invite_apply_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.organization_profile_assert_writer_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.organization_profile_assert_writer_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.organization_profile_assert_writer_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_update_organization_profile_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_update_organization_profile_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_update_organization_profile_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tenant_user_invite_assert_operator_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_user_invite_assert_operator_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_assert_operator_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_list_tenant_invitable_roles_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_tenant_invitable_roles_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_list_tenant_invitable_roles_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tenant_user_invite_apply_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_user_invite_apply_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_apply_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION api.organization_profile_assert_writer_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.organization_profile_assert_writer_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.organization_profile_assert_writer_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_update_organization_profile_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_update_organization_profile_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_update_organization_profile_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.register_artifact_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.register_artifact_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION api.register_artifact_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.register_artifact_v1(JSONB) TO service_role;

REVOKE ALL ON FUNCTION api.tenant_user_invite_assert_operator_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.tenant_user_invite_assert_operator_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.tenant_user_invite_assert_operator_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_list_tenant_invitable_roles_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_list_tenant_invitable_roles_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_list_tenant_invitable_roles_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.tenant_user_invite_apply_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.tenant_user_invite_apply_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.tenant_user_invite_apply_v1(JSONB) TO service_role;

COMMENT ON FUNCTION public.organization_profile_assert_writer_v1(UUID)
  IS 'Console V2 guard: authenticated user must hold organizations.write for the target tenant organization.';
COMMENT ON FUNCTION public.ui_update_organization_profile_v1(JSONB)
  IS 'Canonical Console V2 organization profile/default_settings branding update RPC. Capability: organizations.write.';
COMMENT ON FUNCTION public.tenant_user_invite_assert_operator_v1(UUID)
  IS 'Console V2 guard: authenticated user must hold users.manage before edge user invitation.';
COMMENT ON FUNCTION public.ui_list_tenant_invitable_roles_v1(UUID)
  IS 'Console V2 role picker contract: users.manage-gated tenant RBAC role catalog for invitations and grants.';
COMMENT ON FUNCTION public.tenant_user_invite_apply_v1(JSONB)
  IS 'Service-only apply contract for Console V2 tenant user invitation and RBAC role assignment.';

COMMENT ON FUNCTION api.organization_profile_assert_writer_v1(UUID)
  IS 'API-schema browser wrapper for organization profile write guard.';
COMMENT ON FUNCTION api.ui_update_organization_profile_v1(JSONB)
  IS 'API-schema browser wrapper for organization profile/default branding update.';
COMMENT ON FUNCTION api.register_artifact_v1(JSONB)
  IS 'API-schema service wrapper for canonical artifact registration used by browser-facing edge functions.';
COMMENT ON FUNCTION api.tenant_user_invite_assert_operator_v1(UUID)
  IS 'API-schema browser wrapper for tenant user invite operator guard.';
COMMENT ON FUNCTION api.ui_list_tenant_invitable_roles_v1(UUID)
  IS 'API-schema browser wrapper for tenant RBAC role picker used by Console V2 user invite.';
COMMENT ON FUNCTION api.tenant_user_invite_apply_v1(JSONB)
  IS 'API-schema service wrapper for tenant user invite apply.';

SELECT pg_advisory_unlock(hashtext('202605031300_console_v2_tenant_admin_lifecycle_v1'));

COMMIT;
