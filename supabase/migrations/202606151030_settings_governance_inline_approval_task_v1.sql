-- Migration: Settings governance approval task projection
-- Purpose:
--   - Dispatch pending settings_change.requested events through the workflow engine inline.
--   - Project settings approval manual reviews into the canonical tasks Review Queue.
--   - Resume and apply approved settings from Review Queue approve/reject actions.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202606151030_settings_governance_inline_approval_task_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_lookup_definition_id UUID;
BEGIN
  SELECT id
    INTO v_lookup_definition_id
    FROM public.lookup_definitions
   WHERE category = 'task_type'
   LIMIT 1;

  IF v_lookup_definition_id IS NOT NULL THEN
    INSERT INTO public.lookup_values (
      lookup_definition_id,
      value,
      label,
      description,
      sort_order,
      is_default,
      status,
      metadata
    ) VALUES (
      v_lookup_definition_id,
      'settings_approval',
      'Settings approval',
      'Review requested configuration changes before they become active.',
      570,
      FALSE,
      'active',
      jsonb_build_object(
        'tone', 'warn',
        'reviewer_description', 'Approve or reject a requested settings change.',
        'allowed_actions', jsonb_build_array('approve', 'reject')
      )
    )
    ON CONFLICT (lookup_definition_id, value) DO UPDATE
       SET label = EXCLUDED.label,
           description = EXCLUDED.description,
           status = 'active',
           metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
           updated_at = now();
  END IF;
END $$;

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_task_types JSONB;
  v_next_task_types JSONB := '[]'::jsonb;
  v_item JSONB;
  v_seen BOOLEAN := FALSE;
  v_catalog_entry JSONB := jsonb_build_object(
    'key', 'settings_approval',
    'name', 'Settings approval',
    'description', 'Review requested configuration changes before they become active.',
    'default_priority', 70,
    'default_queue_key', 'settings_governance',
    'enabled', TRUE,
    'default_actions', jsonb_build_array('approve', 'reject'),
    'metadata', jsonb_build_object(
      'assignment_defaults', jsonb_build_object(
        'queue_key', 'settings_governance',
        'allowed_actions', jsonb_build_array('approve', 'reject')
      ),
      'reviewer_description', 'Approve or reject a requested settings change.',
      'tone', 'warn'
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1
   FOR UPDATE OF sv;

  IF v_current IS NULL OR jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'settings_governance_inline_approval_task_v1 requires global task_type_catalog settings';
  END IF;

  v_task_types := COALESCE(v_current->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) IS DISTINCT FROM 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(v_task_types)
  LOOP
    IF lower(COALESCE(v_item->>'key', '')) = 'settings_approval' THEN
      v_seen := TRUE;
      v_item := v_item || (v_catalog_entry - 'metadata');
      v_item := jsonb_set(
        v_item,
        '{metadata}',
        COALESCE(v_item->'metadata', '{}'::jsonb) || COALESCE(v_catalog_entry->'metadata', '{}'::jsonb),
        TRUE
      );
      v_item := jsonb_set(
        v_item,
        '{metadata,assignment_defaults}',
        COALESCE(v_item#>'{metadata,assignment_defaults}', '{}'::jsonb)
          || COALESCE(v_catalog_entry#>'{metadata,assignment_defaults}', '{}'::jsonb),
        TRUE
      );
    END IF;
    v_next_task_types := v_next_task_types || jsonb_build_array(v_item);
  END LOOP;

  IF NOT v_seen THEN
    v_next_task_types := v_next_task_types || jsonb_build_array(v_catalog_entry);
  END IF;

  v_next := jsonb_set(v_current, '{task_types}', v_next_task_types, TRUE);

  IF v_next IS DISTINCT FROM v_current THEN
    UPDATE public.settings_versions sv
       SET value = v_next,
           change_reason = 'Add settings approval task catalog entry for Review Queue projection'
     WHERE sv.id = (
       SELECT s.settings_version_id
         FROM public.settings s
        WHERE s.category = 'task_type_catalog'
          AND s.scope_type = 'global'
          AND s.scope_id IS NULL
        LIMIT 1
     );

    UPDATE public.settings s
       SET cached_value = v_next,
           last_updated = now()
     WHERE s.category = 'task_type_catalog'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL;
  END IF;
END $$;

UPDATE public.task_types
   SET default_priority = GREATEST(default_priority, 70),
       default_queue_key = 'settings_governance',
       metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{assignment_defaults}',
         COALESCE(metadata->'assignment_defaults', '{}'::jsonb)
           || jsonb_build_object(
             'queue_key', 'settings_governance',
             'allowed_actions', jsonb_build_array('approve', 'reject')
           ),
         TRUE
       ),
       updated_at = now()
 WHERE key = 'settings_approval';

UPDATE public.workflow_template_steps
   SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{workflow_resume_on_resolve}',
         'true'::jsonb,
         TRUE
       ),
       updated_at = now()
 WHERE workflow_template_id = '99990000-0000-0000-0000-000000560020'::uuid
   AND handler_key = 'manual_review'
   AND operation_name = 'settings_change_manual_review_enqueue';

DO $$
DECLARE
  v_settings public.settings%ROWTYPE;
  v_value JSONB;
BEGIN
  SELECT *
    INTO v_settings
    FROM public.settings
   WHERE category = 'domain_event_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'settings governance approval requires global domain_event_policy settings';
  END IF;

  v_value := COALESCE(v_settings.cached_value, '{}'::jsonb)
    || jsonb_build_object(
      'events',
      COALESCE(v_settings.cached_value->'events', '{}'::jsonb)
      || jsonb_build_object(
        'settings_change.requested',
        COALESCE(v_settings.cached_value #> '{events,settings_change.requested}', '{}'::jsonb)
        || jsonb_build_object(
          'workflow_template_id',
          '99990000-0000-0000-0000-000000560020'
        )
      )
    );

  IF v_value IS DISTINCT FROM v_settings.cached_value THEN
    UPDATE public.settings_versions
       SET value = v_value,
           change_reason = 'Restore settings_change.requested workflow policy for settings governance approval',
           approved_at = COALESCE(approved_at, now()),
           effective_from = COALESCE(effective_from, now()),
           updated_at = now()
     WHERE id = v_settings.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_value,
           last_updated = now()
     WHERE id = v_settings.id;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.settings_version_resolved_organization_v1(
  p_settings_version_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_sv public.settings_versions%ROWTYPE;
  v_org UUID := NULL;
BEGIN
  SELECT *
    INTO v_sv
    FROM public.settings_versions sv
   WHERE sv.id = p_settings_version_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'settings_version_resolved_organization_v1 settings_version not found: %', p_settings_version_id;
  END IF;

  IF v_sv.scope_type = 'tenant' THEN
    v_org := v_sv.scope_id;
  ELSIF v_sv.scope_type = 'client' THEN
    SELECT c.organization_id INTO v_org FROM public.clients c WHERE c.id = v_sv.scope_id;
  ELSIF v_sv.scope_type = 'sender' THEN
    SELECT c.organization_id INTO v_org
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_sv.scope_id;
  ELSIF v_sv.scope_type = 'source' THEN
    SELECT ws.organization_id INTO v_org FROM public.webhook_sources ws WHERE ws.id = v_sv.scope_id;
  ELSIF v_sv.scope_type IN ('global', 'resource') THEN
    v_org := NULL;
  ELSE
    RAISE EXCEPTION 'settings_version_resolved_organization_v1 unsupported scope_type=%', v_sv.scope_type
      USING ERRCODE = '23514';
  END IF;

  RETURN v_org;
END;
$function$;

CREATE OR REPLACE FUNCTION public.settings_approval_review_task_defaults_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NEW.task_type = 'settings_approval' THEN
    NEW.metadata := jsonb_strip_nulls(
      COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'workflow_resume_on_resolve', TRUE,
        'task_type_key', 'settings_approval',
        'task_type', 'settings_approval',
        'allowed_actions', jsonb_build_array('approve', 'reject'),
        'subject', 'Settings approval',
        'resource_type', COALESCE(NEW.resource_type, 'settings_version'),
        'resource_id', NEW.resource_id
      )
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_settings_approval_review_task_defaults_v1 ON public.manual_review_tasks;
CREATE TRIGGER trg_settings_approval_review_task_defaults_v1
  BEFORE INSERT OR UPDATE OF task_type, metadata, resource_type, resource_id
  ON public.manual_review_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.settings_approval_review_task_defaults_v1();

UPDATE public.manual_review_tasks
   SET metadata = jsonb_strip_nulls(
         COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object(
           'workflow_resume_on_resolve', TRUE,
           'task_type_key', 'settings_approval',
           'task_type', 'settings_approval',
           'allowed_actions', jsonb_build_array('approve', 'reject'),
           'subject', 'Settings approval',
           'resource_type', COALESCE(resource_type, 'settings_version'),
           'resource_id', resource_id
         )
       ),
       updated_at = now()
 WHERE task_type = 'settings_approval'
   AND (
     COALESCE(metadata->>'workflow_resume_on_resolve', 'false') <> 'true'
     OR COALESCE(metadata->>'task_type_key', '') <> 'settings_approval'
   );

CREATE OR REPLACE FUNCTION public.settings_approval_review_queue_task_sync_v1(
  p_manual_review_task_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_review public.manual_review_tasks%ROWTYPE;
  v_settings_version public.settings_versions%ROWTYPE;
  v_task_id UUID;
  v_workflow_run_id UUID := NULL;
  v_resolved_org UUID := NULL;
  v_previous_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_previous_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_previous_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_claims JSONB := '{}'::jsonb;
BEGIN
  SELECT *
    INTO v_review
    FROM public.manual_review_tasks mrt
   WHERE mrt.id = p_manual_review_task_id
     AND mrt.task_type = 'settings_approval'
     AND mrt.resource_type = 'settings_version'
     AND mrt.resource_id IS NOT NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_settings_version
    FROM public.settings_versions sv
   WHERE sv.id = v_review.resource_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'settings_approval Review Queue projection references missing settings_version %', v_review.resource_id;
  END IF;

  v_resolved_org := public.settings_version_resolved_organization_v1(v_settings_version.id);
  IF v_resolved_org IS NOT NULL AND v_review.organization_id IS DISTINCT FROM v_resolved_org THEN
    RAISE EXCEPTION 'settings_approval Review Queue projection organization_id % does not own settings_version %',
      v_review.organization_id,
      v_settings_version.id;
  END IF;

  BEGIN
    v_workflow_run_id := NULLIF(v_review.metadata->>'workflow_run_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_workflow_run_id := NULL;
  END;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := '{}'::jsonb;
  END;
  IF jsonb_typeof(v_claims) IS DISTINCT FROM 'object' THEN
    v_claims := '{}'::jsonb;
  END IF;

  PERFORM set_config('request.jwt.claims', (v_claims || jsonb_build_object('role', 'service_role'))::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  BEGIN
    SELECT created.task_id
      INTO v_task_id
      FROM public.create_task_system_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', 'settings_approval',
          'context', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_review.organization_id,
            'manual_review_task_id', v_review.id,
            'workflow_run_id', v_workflow_run_id,
            'resource_type', v_review.resource_type,
            'resource_id', v_review.resource_id,
            'settings_category', v_settings_version.category,
            'settings_scope_type', v_settings_version.scope_type,
            'settings_scope_id', v_settings_version.scope_id
          )),
          'resource_type', 'settings_version',
          'resource_id', v_review.resource_id,
          'queue_key', COALESCE(NULLIF(v_review.queue_assignment, ''), 'settings_governance'),
          'sla_minutes', v_review.sla_minutes,
          'idempotency_key', 'settings-approval:' || v_review.id::text,
          'metadata', jsonb_strip_nulls(COALESCE(v_review.metadata, '{}'::jsonb) || jsonb_build_object(
            'manual_review_task_id', v_review.id,
            'workflow_run_id', v_workflow_run_id,
            'parent_workflow_run_id', v_workflow_run_id,
            'settings_version_id', v_settings_version.id,
            'settings_category', v_settings_version.category,
            'settings_scope_type', v_settings_version.scope_type,
            'settings_scope_id', v_settings_version.scope_id,
            'task_type_key', 'settings_approval',
            'task_type', 'settings_approval',
            'subject', 'Settings approval',
            'description', COALESCE(NULLIF(v_review.reason, ''), 'Review requested settings change'),
            'allowed_actions', jsonb_build_array('approve', 'reject'),
            'resource_type', 'settings_version',
            'resource_id', v_review.resource_id,
            'workflow_resume_on_resolve', TRUE
          )),
          'actor_system', 'settings_approval_review_queue_task_sync_v1'
        ))
      ) AS created
     LIMIT 1;
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_previous_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_previous_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_previous_sub, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_previous_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_previous_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_previous_sub, true);

  IF v_task_id IS NOT NULL THEN
    UPDATE public.manual_review_tasks
       SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'operator_task_id', v_task_id,
             'review_queue_resource', 'tasks'
           )),
           updated_at = now()
     WHERE id = v_review.id
       AND COALESCE(metadata->>'operator_task_id', '') IS DISTINCT FROM v_task_id::text;
  END IF;

  RETURN v_task_id;
END;
$function$;

DO $$
DECLARE
  v_review_id UUID;
BEGIN
  FOR v_review_id IN
    SELECT mrt.id
      FROM public.manual_review_tasks mrt
     WHERE mrt.task_type = 'settings_approval'
       AND mrt.resource_type = 'settings_version'
       AND mrt.resource_id IS NOT NULL
       AND mrt.status = 'pending'
  LOOP
    PERFORM public.settings_approval_review_queue_task_sync_v1(v_review_id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.settings_approval_operator_task_resolve_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_task_type_key TEXT;
  v_manual_review_task_id UUID;
  v_outcome TEXT;
  v_user_id UUID;
  v_review public.manual_review_tasks%ROWTYPE;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.status, '') IS NOT DISTINCT FROM COALESCE(OLD.status, '') THEN
    RETURN NEW;
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = NEW.task_type_id;

  IF v_task_type_key IS DISTINCT FROM 'settings_approval' THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_manual_review_task_id := NULLIF(NEW.metadata->>'manual_review_task_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_manual_review_task_id := NULL;
  END;

  IF v_manual_review_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_outcome := CASE
    WHEN lower(NEW.status) IN ('completed', 'approved') THEN 'approved'
    WHEN lower(NEW.status) IN ('rejected', 'canceled', 'cancelled') THEN 'rejected'
    ELSE NULL
  END;

  IF v_outcome IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_review
    FROM public.manual_review_tasks mrt
   WHERE mrt.id = v_manual_review_task_id
   FOR UPDATE;

  IF NOT FOUND OR v_review.status = 'resolved' THEN
    RETURN NEW;
  END IF;

  SELECT auth.uid() INTO v_user_id;

  UPDATE public.manual_review_tasks
     SET status = 'resolved',
         resolution_outcome = v_outcome,
         resolution_notes = COALESCE(NULLIF(NEW.status_reason, ''), 'Resolved from operator Review Queue task'),
         resolved_by = v_user_id,
         resolved_at = now(),
         metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'operator_task_id', NEW.id,
           'operator_task_status', NEW.status
         )),
         updated_at = now()
   WHERE id = v_manual_review_task_id;

  PERFORM public.log_decision(
    p_organization_id := v_review.organization_id,
    p_decision_category := 'manual_review',
    p_resource_type := 'manual_review_task',
    p_resource_id := v_manual_review_task_id,
    p_decision_point := 'resolve_task',
    p_decision_outcome := v_outcome,
    p_performed_by_system := 'settings_approval_operator_task_resolve_v1',
    p_correlation_id := NULL,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'operator_task_id', NEW.id,
      'operator_task_status', NEW.status,
      'task_type', 'settings_approval',
      'resource_type', v_review.resource_type,
      'resource_id', v_review.resource_id
    )),
    p_decision_reason := COALESCE(NULLIF(NEW.status_reason, ''), 'Resolved from operator Review Queue task')
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_settings_approval_operator_task_resolve_v1 ON public.tasks;
CREATE TRIGGER trg_settings_approval_operator_task_resolve_v1
  AFTER UPDATE OF status, status_reason
  ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.settings_approval_operator_task_resolve_v1();

CREATE OR REPLACE FUNCTION public.settings_change_requested_inline_approval_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_template UUID;
  v_context_patch JSONB;
  v_workflow_context JSONB;
  v_run_id UUID;
  v_progress JSONB;
  v_task_id UUID;
  v_operator_task_id UUID;
  v_org UUID;
  v_resolved_org UUID;
  v_settings_version public.settings_versions%ROWTYPE;
  v_existing_run UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type <> 'settings_change.requested' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.status, '') <> 'pending' THEN
    RETURN NEW;
  END IF;

  IF NEW.resource_type <> 'settings_version' OR NEW.resource_id IS NULL THEN
    RAISE EXCEPTION 'settings_change.requested requires settings_version resource lineage';
  END IF;

  SELECT *
    INTO v_settings_version
    FROM public.settings_versions sv
   WHERE sv.id = NEW.resource_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'settings_change.requested referenced settings_version % was not found', NEW.resource_id;
  END IF;

  v_resolved_org := public.settings_version_resolved_organization_v1(NEW.resource_id);
  v_org := COALESCE(NEW.organization_id, v_resolved_org);

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'settings_change.requested could not resolve organization_id';
  END IF;

  IF v_resolved_org IS NOT NULL AND v_org IS DISTINCT FROM v_resolved_org THEN
    RAISE EXCEPTION 'settings_change.requested organization_id % does not match settings_version organization %',
      v_org,
      v_resolved_org;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('settings_change.requested:' || NEW.resource_id::text));

  SELECT de.workflow_run_id
    INTO v_existing_run
    FROM public.domain_events de
   WHERE de.id <> NEW.id
     AND de.event_type = NEW.event_type
     AND de.resource_type = NEW.resource_type
     AND de.resource_id = NEW.resource_id
     AND de.workflow_run_id IS NOT NULL
     AND de.status IN ('processing', 'completed', 'failed')
   ORDER BY de.created_at ASC
   LIMIT 1;

  IF v_existing_run IS NOT NULL THEN
    UPDATE public.domain_events
       SET status = 'skipped',
           error_reason = 'duplicate settings_change.requested event for settings_version',
           workflow_run_id = v_existing_run,
           processed_at = now(),
           updated_at = now()
     WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  v_policy := public.resolve_domain_event_policy(v_org, NEW.event_type);
  v_template := NULLIF(v_policy->>'workflow_template_id', '')::uuid;
  v_context_patch := COALESCE(v_policy->'context_patch', '{}'::jsonb);

  IF v_template IS NULL THEN
    RAISE EXCEPTION 'settings_change.requested missing workflow_template_id policy';
  END IF;

  v_workflow_context := jsonb_strip_nulls(
    jsonb_build_object(
      'organization_id', v_org,
      'domain_event_id', NEW.id,
      'event_type', NEW.event_type,
      'resource_type', NEW.resource_type,
      'resource_id', NEW.resource_id,
      'payload', NEW.payload,
      'trigger_source', 'domain_event',
      'correlation_id', NEW.correlation_id
    )
  ) || jsonb_strip_nulls(v_context_patch);

  v_run_id := public.start_workflow_run(v_template, v_workflow_context);

  UPDATE public.domain_events
     SET status = 'processing',
         organization_id = v_org,
         workflow_run_id = v_run_id,
         processed_at = now(),
         updated_at = now()
   WHERE id = NEW.id;

  PERFORM public.log_decision(
    p_organization_id := v_org,
    p_decision_category := 'domain_event',
    p_resource_type := 'domain_event',
    p_resource_id := NEW.id,
    p_decision_point := 'dispatch',
    p_decision_outcome := 'enqueued',
    p_performed_by_system := 'settings_change_requested_inline_approval_v1',
    p_correlation_id := NEW.correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'workflow_run_id', v_run_id,
      'workflow_template_id', v_template,
      'event_type', NEW.event_type,
      'resource_type', NEW.resource_type,
      'resource_id', NEW.resource_id
    )),
    p_decision_reason := NULL
  );

  v_progress := public.progress_workflow_run_until_wait_v1(
    v_run_id,
    '{}'::jsonb,
    1000,
    3
  );

  SELECT mrt.id
    INTO v_task_id
    FROM public.manual_review_tasks mrt
   WHERE mrt.task_type = 'settings_approval'
     AND mrt.resource_type = 'settings_version'
     AND mrt.resource_id = NEW.resource_id
     AND NULLIF(mrt.metadata->>'workflow_run_id', '')::uuid = v_run_id
   ORDER BY mrt.created_at DESC
   LIMIT 1;

  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'settings_change.requested did not create settings_approval manual review task (event_id=%, workflow_run_id=%, progress=%)',
      NEW.id,
      v_run_id,
      v_progress;
  END IF;

  v_operator_task_id := public.settings_approval_review_queue_task_sync_v1(v_task_id);
  IF v_operator_task_id IS NULL THEN
    RAISE EXCEPTION 'settings_change.requested did not project settings_approval into Review Queue tasks (event_id=%, manual_review_task_id=%)',
      NEW.id,
      v_task_id;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_settings_change_requested_inline_approval_v1 ON public.domain_events;
CREATE TRIGGER trg_settings_change_requested_inline_approval_v1
  AFTER INSERT
  ON public.domain_events
  FOR EACH ROW
  WHEN (NEW.event_type = 'settings_change.requested')
  EXECUTE FUNCTION public.settings_change_requested_inline_approval_v1();

COMMENT ON FUNCTION public.settings_version_resolved_organization_v1(UUID)
  IS 'Resolve the owning organization for scoped settings_versions rows. Global/resource scopes return NULL and are validated by event organization lineage.';

COMMENT ON FUNCTION public.settings_change_requested_inline_approval_v1()
  IS 'Synchronously dispatches pending settings_change.requested events through the row-driven workflow policy and projects settings approvals into the canonical tasks Review Queue.';

COMMENT ON FUNCTION public.settings_approval_review_task_defaults_v1()
  IS 'Ensures settings_approval manual review tasks carry workflow resume and Review Queue metadata.';

COMMENT ON FUNCTION public.settings_approval_review_queue_task_sync_v1(UUID)
  IS 'Projects a settings_approval manual_review_tasks row into the canonical tasks Review Queue using create_task_system_v1 and idempotency.';

COMMENT ON FUNCTION public.settings_approval_operator_task_resolve_v1()
  IS 'Resolves the backing settings_approval manual_review_tasks row when the operator-facing tasks Review Queue row is completed or rejected.';

COMMIT;
