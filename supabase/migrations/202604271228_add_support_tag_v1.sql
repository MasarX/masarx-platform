-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: add_support_tag_v1
-- Date: 2026-04-27
--
-- Purpose:
--   Append (or remove) a tag on a support case. Writes the action history to
--   support_case_tags (immutable) and updates the denormalized tags[] projection
--   on support_cases. Idempotent for "already attached / already detached".
--
-- Args (jsonb p_args):
--   support_case_id   uuid (required)
--   tag               text (required; lowercased)
--   action            text (optional; 'add' (default) | 'remove')
--   correlation_id    uuid (optional)
--
-- Returns: { ok, support_case_id, tag, action, version, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271228_add_support_tag_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.add_support_tag_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_case_id UUID;
  v_case RECORD;
  v_tag TEXT;
  v_action TEXT;
  v_correlation_id UUID;
  v_resolution RECORD;
  v_settings_resolution_id UUID;
  v_already BOOLEAN := FALSE;
  v_new_tags TEXT[];
  v_new_version INT;
BEGIN
  PERFORM public.assert_capability_v1('support.write');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'add_support_tag_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  BEGIN v_case_id := NULLIF(v_args->>'support_case_id', '')::UUID;
  EXCEPTION WHEN others THEN v_case_id := NULL; END;
  IF v_case_id IS NULL THEN
    RAISE EXCEPTION 'add_support_tag_v1 requires support_case_id' USING ERRCODE = '23502';
  END IF;

  v_tag := lower(NULLIF(btrim(COALESCE(v_args->>'tag', '')), ''));
  IF v_tag IS NULL THEN
    RAISE EXCEPTION 'add_support_tag_v1 requires tag' USING ERRCODE = '23502';
  END IF;

  v_action := lower(NULLIF(btrim(COALESCE(v_args->>'action', '')), ''));
  IF v_action IS NULL THEN
    v_action := 'add';
  END IF;
  IF v_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'add_support_tag_v1: action must be add or remove' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_case FROM public.support_cases WHERE id = v_case_id LIMIT 1;
  IF v_case.id IS NULL THEN
    RAISE EXCEPTION 'add_support_tag_v1: support_case % not found', v_case_id USING ERRCODE = '23503';
  END IF;
  IF NOT public.is_platform_user() AND v_case.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'add_support_tag_v1: cross-tenant access denied' USING ERRCODE = '42501';
  END IF;

  -- Idempotency
  IF v_action = 'add' AND v_case.tags IS NOT NULL AND v_tag = ANY(v_case.tags) THEN
    v_already := TRUE;
  ELSIF v_action = 'remove' AND (v_case.tags IS NULL OR NOT v_tag = ANY(v_case.tags)) THEN
    v_already := TRUE;
  END IF;

  BEGIN v_correlation_id := NULLIF(v_args->>'correlation_id', '')::UUID;
  EXCEPTION WHEN others THEN v_correlation_id := NULL; END;
  IF v_correlation_id IS NULL THEN v_correlation_id := gen_random_uuid(); END IF;

  -- Settings resolution
  BEGIN
    SELECT * INTO v_resolution
      FROM public.resolve_settings_row_from_context(
        'support_case_policy',
        jsonb_strip_nulls(jsonb_build_object(
          'organization_id', v_case.organization_id,
          'tenant_id', v_case.organization_id,
          'client_id', v_case.client_id,
          'sender_id', v_case.sender_id
        ))) LIMIT 1;
  EXCEPTION WHEN others THEN v_resolution := NULL; END;
  IF v_resolution.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id => v_case.organization_id,
      p_category => 'support_case_policy',
      p_winning_scope_type => v_resolution.scope_type,
      p_winning_scope_id => v_resolution.scope_id,
      p_winning_settings_id => v_resolution.settings_id,
      p_winning_settings_version_id => v_resolution.settings_version_id,
      p_winning_version => v_resolution.version,
      p_scope_path => COALESCE(v_resolution.scope_path, '[]'::jsonb),
      p_inputs => jsonb_build_object('action', v_action, 'tag', v_tag)
    );
  END IF;

  IF NOT v_already THEN
    -- Build new denormalized tags[] projection.
    IF v_action = 'add' THEN
      v_new_tags := (
        SELECT array(
          SELECT DISTINCT t
          FROM unnest(COALESCE(v_case.tags, ARRAY[]::TEXT[]) || ARRAY[v_tag]) t
          ORDER BY t
        )
      );
    ELSE
      v_new_tags := (
        SELECT array(
          SELECT t FROM unnest(COALESCE(v_case.tags, ARRAY[]::TEXT[])) t
           WHERE t <> v_tag
           ORDER BY t
        )
      );
    END IF;

    v_new_version := v_case.version + 1;

    UPDATE public.support_cases
       SET tags = COALESCE(v_new_tags, ARRAY[]::TEXT[]),
           version = v_new_version,
           updated_at = now()
     WHERE id = v_case_id;

    -- Insert immutable history row.
    INSERT INTO public.support_case_tags (
      support_case_id, organization_id, tag, action,
      actor_user_id, metadata
    ) VALUES (
      v_case_id, v_case.organization_id, v_tag, v_action,
      v_user_id,
      jsonb_strip_nulls(jsonb_build_object('correlation_id', v_correlation_id))
    );

    -- Append case event.
    INSERT INTO public.support_case_events (
      support_case_id, organization_id, event_type, from_status, to_status,
      actor_user_id, payload, case_version, settings_resolution_id
    ) VALUES (
      v_case_id, v_case.organization_id,
      CASE WHEN v_action = 'add' THEN 'support_case.tag_added' ELSE 'support_case.tag_removed' END,
      v_case.status, v_case.status,
      v_user_id,
      jsonb_strip_nulls(jsonb_build_object('tag', v_tag, 'action', v_action)),
      v_new_version, v_settings_resolution_id
    );

    PERFORM public.enqueue_domain_event(
      p_organization_id => v_case.organization_id,
      p_event_type => CASE WHEN v_action = 'add' THEN 'support_case.tag_added' ELSE 'support_case.tag_removed' END,
      p_resource_type => 'support_case',
      p_resource_id => v_case_id,
      p_payload => jsonb_strip_nulls(jsonb_build_object(
        'support_case_id', v_case_id,
        'tag', v_tag,
        'action', v_action
      )),
      p_correlation_id => v_correlation_id
    );

    PERFORM public.log_decision(
      p_organization_id => v_case.organization_id,
      p_decision_category => 'support_case.tag',
      p_resource_type => 'support_case',
      p_resource_id => v_case_id,
      p_decision_point => 'tag',
      p_decision_outcome => v_action,
      p_performed_by_system => 'add_support_tag_v1',
      p_correlation_id => v_correlation_id,
      p_decision_inputs => jsonb_build_object('tag', v_tag, 'action', v_action),
      p_settings_resolution_id => v_settings_resolution_id
    );
  ELSE
    v_new_version := v_case.version;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case_id,
    'tag', v_tag,
    'action', v_action,
    'version', v_new_version,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id,
    'already_processed', CASE WHEN v_already THEN TRUE ELSE NULL END
  ));
END;
$function$;

COMMENT ON FUNCTION public.add_support_tag_v1(JSONB)
  IS 'Canonical RPC to add or remove a tag on a support case. Writes immutable history to support_case_tags + denormalizes onto support_cases.tags. Idempotent.';

REVOKE ALL ON FUNCTION public.add_support_tag_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_support_tag_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.add_support_tag_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604271228_add_support_tag_v1'));
COMMIT;
