-- Migration: Support case escalation lifecycle
-- Purpose: Add a backend-backed, policy-driven escalation action for Console V2 Support Cases.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605312345_support_case_escalation_lifecycle_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

WITH definition AS (
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
  'support_case.escalate',
  'Support Case Escalate',
  'Decision category emitted when an operator escalates a support case through the canonical lifecycle RPC.',
  1155,
  FALSE,
  'active',
  jsonb_build_object('source', 'support_case_escalation_lifecycle_v1')
FROM definition d
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH escalation_defaults AS (
  SELECT jsonb_build_object(
    'version', 1,
    'escalation', jsonb_build_object(
      'target_priority', 'urgent',
      'default_reason', 'operator escalation',
      'min_reason_length', 4,
      'case_event_type', 'escalated',
      'domain_event_type', 'support_case.escalated',
      'decision_category', 'support_case.escalate'
    )
  ) AS body
)
UPDATE public.schema_registry
   SET schema = public.deep_merge_jsonb(
         schema,
         '{
           "properties": {
             "escalation": {
               "type": "object",
               "additionalProperties": true,
               "properties": {
                 "target_priority": { "type": "string", "minLength": 1 },
                 "default_reason": { "type": "string", "minLength": 1 },
                 "min_reason_length": { "type": "integer", "minimum": 1 },
                 "case_event_type": { "type": "string", "minLength": 1 },
                 "domain_event_type": { "type": "string", "minLength": 1 },
                 "decision_category": { "type": "string", "minLength": 1 }
               },
               "required": ["target_priority", "default_reason", "min_reason_length", "case_event_type", "domain_event_type", "decision_category"]
             }
           }
         }'::jsonb
       ),
       examples = CASE
         WHEN jsonb_path_exists(COALESCE(examples, '[]'::jsonb), '$[*].escalation.target_priority') THEN COALESCE(examples, '[]'::jsonb)
         ELSE COALESCE(examples, '[]'::jsonb) || jsonb_build_array((
           SELECT public.deep_merge_jsonb(
             '{"version":1,"recent_shipments_limit":6,"recent_decisions_limit":5}'::jsonb,
             body
           )
           FROM escalation_defaults
         ))
       END
 WHERE category = 'support_policy'
   AND version = 1;

WITH escalation_defaults AS (
  SELECT jsonb_build_object(
    'escalation', jsonb_build_object(
      'target_priority', 'urgent',
      'default_reason', 'operator escalation',
      'min_reason_length', 4,
      'case_event_type', 'escalated',
      'domain_event_type', 'support_case.escalated',
      'decision_category', 'support_case.escalate'
    )
  ) AS body
)
UPDATE public.settings_versions sv
   SET value = public.deep_merge_jsonb(value, (SELECT body FROM escalation_defaults))
 WHERE category = 'support_policy'
   AND effective_until IS NULL
   AND approved_at IS NOT NULL;

WITH escalation_defaults AS (
  SELECT jsonb_build_object(
    'escalation', jsonb_build_object(
      'target_priority', 'urgent',
      'default_reason', 'operator escalation',
      'min_reason_length', 4,
      'case_event_type', 'escalated',
      'domain_event_type', 'support_case.escalated',
      'decision_category', 'support_case.escalate'
    )
  ) AS body
)
UPDATE public.settings s
   SET cached_value = public.deep_merge_jsonb(cached_value, (SELECT body FROM escalation_defaults)),
       last_updated = now()
 WHERE category = 'support_policy';

CREATE OR REPLACE FUNCTION public.escalate_support_case_v1(p_args JSONB)
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
  v_reason TEXT;
  v_correlation_id UUID;
  v_policy RECORD;
  v_escalation JSONB;
  v_target_priority TEXT;
  v_case_event_type TEXT;
  v_domain_event_type TEXT;
  v_decision_category TEXT;
  v_min_reason_length INT;
  v_settings_resolution_id UUID;
  v_new_version INT;
  v_current_priority_rank INT;
  v_target_priority_rank INT;
  v_next_priority TEXT;
  v_escalation_count INT;
  v_already BOOLEAN := FALSE;
BEGIN
  PERFORM public.assert_capability_v1('support.write');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'escalate_support_case_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  BEGIN v_case_id := NULLIF(v_args->>'support_case_id', '')::UUID;
  EXCEPTION WHEN others THEN v_case_id := NULL; END;
  IF v_case_id IS NULL THEN
    RAISE EXCEPTION 'escalate_support_case_v1 requires support_case_id' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_case FROM public.support_cases WHERE id = v_case_id LIMIT 1;
  IF v_case.id IS NULL THEN
    RAISE EXCEPTION 'escalate_support_case_v1: support_case % not found', v_case_id USING ERRCODE = '23503';
  END IF;
  IF NOT public.is_platform_user() AND v_case.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'escalate_support_case_v1: cross-tenant access denied' USING ERRCODE = '42501';
  END IF;
  IF v_case.status IN ('resolved', 'closed', 'canceled') THEN
    RAISE EXCEPTION 'escalate_support_case_v1: terminal support case cannot be escalated' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_policy
    FROM public.resolve_settings_row_from_context(
      'support_policy',
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_case.organization_id,
        'tenant_id', v_case.organization_id,
        'client_id', v_case.client_id,
        'sender_id', v_case.sender_id
      ))) LIMIT 1;
  IF v_policy.settings_id IS NULL THEN
    RAISE EXCEPTION 'escalate_support_case_v1 requires support_policy' USING ERRCODE = '23502';
  END IF;
  v_escalation := COALESCE(v_policy.value->'escalation', '{}'::jsonb);
  v_target_priority := NULLIF(btrim(v_escalation->>'target_priority'), '');
  v_case_event_type := NULLIF(btrim(v_escalation->>'case_event_type'), '');
  v_domain_event_type := NULLIF(btrim(v_escalation->>'domain_event_type'), '');
  v_decision_category := NULLIF(btrim(v_escalation->>'decision_category'), '');
  v_min_reason_length := COALESCE(NULLIF(v_escalation->>'min_reason_length', '')::INT, 1);

  IF v_target_priority IS NULL OR v_case_event_type IS NULL OR v_domain_event_type IS NULL OR v_decision_category IS NULL THEN
    RAISE EXCEPTION 'escalate_support_case_v1 requires complete support_policy.escalation configuration'
      USING ERRCODE = '23502';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(v_args->>'reason', v_escalation->>'default_reason', '')), '');
  IF v_reason IS NULL OR length(v_reason) < v_min_reason_length THEN
    RAISE EXCEPTION 'escalate_support_case_v1 requires escalation reason with at least % characters', v_min_reason_length
      USING ERRCODE = '23502';
  END IF;

  SELECT lv.sort_order INTO v_target_priority_rank
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'support_case_priority'
     AND lv.value = v_target_priority
     AND lv.retired_at IS NULL
   LIMIT 1;
  IF v_target_priority_rank IS NULL THEN
    RAISE EXCEPTION 'escalate_support_case_v1 target priority % is not active', v_target_priority
      USING ERRCODE = '23514';
  END IF;

  SELECT lv.sort_order INTO v_current_priority_rank
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'support_case_priority'
     AND lv.value = v_case.priority
     AND lv.retired_at IS NULL
   LIMIT 1;

  v_next_priority := CASE
    WHEN v_current_priority_rank IS NULL OR v_current_priority_rank > v_target_priority_rank
      THEN v_target_priority
    ELSE v_case.priority
  END;

  v_already :=
    v_case.priority = v_next_priority
    AND COALESCE(v_case.metadata->'escalation'->>'reason', '') = v_reason
    AND COALESCE(v_case.metadata->'escalation'->>'case_event_type', '') = v_case_event_type;

  BEGIN v_correlation_id := NULLIF(v_args->>'correlation_id', '')::UUID;
  EXCEPTION WHEN others THEN v_correlation_id := NULL; END;
  IF v_correlation_id IS NULL THEN v_correlation_id := gen_random_uuid(); END IF;

  v_settings_resolution_id := public.log_settings_resolution(
    p_organization_id => v_case.organization_id,
    p_category => 'support_policy',
    p_winning_scope_type => v_policy.scope_type,
    p_winning_scope_id => v_policy.scope_id,
    p_winning_settings_id => v_policy.settings_id,
    p_winning_settings_version_id => v_policy.settings_version_id,
    p_winning_version => v_policy.version,
    p_scope_path => COALESCE(v_policy.scope_path, '[]'::jsonb),
    p_inputs => jsonb_build_object('action', 'escalate_support_case')
  );

  IF NOT v_already THEN
    v_new_version := v_case.version + 1;
    v_escalation_count := COALESCE(NULLIF(v_case.metadata->'escalation'->>'count', '')::INT, 0) + 1;
    UPDATE public.support_cases
       SET priority = v_next_priority,
           metadata = public.deep_merge_jsonb(
             COALESCE(metadata, '{}'::jsonb),
             jsonb_build_object(
               'escalation', jsonb_build_object(
                 'count', v_escalation_count,
                 'reason', v_reason,
                 'target_priority', v_target_priority,
                 'previous_priority', v_case.priority,
                 'case_event_type', v_case_event_type,
                 'escalated_at', now(),
                 'escalated_by_user_id', v_user_id
               )
             )
           ),
           version = v_new_version,
           updated_at = now()
     WHERE id = v_case_id;

    INSERT INTO public.support_case_events (
      support_case_id, organization_id, event_type, from_status, to_status,
      actor_user_id, payload, case_version, settings_resolution_id
    ) VALUES (
      v_case_id, v_case.organization_id,
      v_case_event_type,
      v_case.status, v_case.status,
      v_user_id,
      jsonb_build_object(
        'reason', v_reason,
        'previous_priority', v_case.priority,
        'target_priority', v_target_priority,
        'priority', v_next_priority,
        'escalation_count', v_escalation_count
      ),
      v_new_version, v_settings_resolution_id
    );

    PERFORM public.enqueue_domain_event(
      p_organization_id => v_case.organization_id,
      p_event_type => v_domain_event_type,
      p_resource_type => 'support_case',
      p_resource_id => v_case_id,
      p_payload => jsonb_build_object(
        'support_case_id', v_case_id,
        'reason', v_reason,
        'previous_priority', v_case.priority,
        'priority', v_next_priority,
        'escalation_count', v_escalation_count
      ),
      p_correlation_id => v_correlation_id
    );

    PERFORM public.log_decision(
      p_organization_id => v_case.organization_id,
      p_decision_category => v_decision_category,
      p_resource_type => 'support_case',
      p_resource_id => v_case_id,
      p_decision_point => 'escalate',
      p_decision_outcome => v_next_priority,
      p_performed_by_system => 'escalate_support_case_v1',
      p_correlation_id => v_correlation_id,
      p_decision_inputs => jsonb_build_object(
        'reason', v_reason,
        'previous_priority', v_case.priority,
        'priority', v_next_priority,
        'case_event_type', v_case_event_type
      ),
      p_settings_resolution_id => v_settings_resolution_id
    );
  ELSE
    v_new_version := v_case.version;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case_id,
    'priority', v_next_priority,
    'status', v_case.status,
    'reason', v_reason,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_settings_resolution_id,
    'version', v_new_version,
    'already_processed', CASE WHEN v_already THEN TRUE ELSE NULL END
  ));
END;
$function$;

COMMENT ON FUNCTION public.escalate_support_case_v1(JSONB)
  IS 'Policy-driven support case escalation. Capability-gated; updates priority, appends support_case_events, domain_events, and decision_log lineage.';

REVOKE ALL ON FUNCTION public.escalate_support_case_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.escalate_support_case_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.escalate_support_case_v1(JSONB) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.escalate_support_case_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.escalate_support_case_v1(p_args);
$function$;

COMMENT ON FUNCTION api.escalate_support_case_v1(JSONB)
  IS 'Console V2 api-schema wrapper for public.escalate_support_case_v1.';

REVOKE ALL ON FUNCTION api.escalate_support_case_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.escalate_support_case_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.escalate_support_case_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605312345_support_case_escalation_lifecycle_v1'));

COMMIT;
