-- Console V2 Review Queue: make marketing_lead_followup reviewer metadata canonical.
--
-- Landing follow-up tasks are created through workflow/task catalog paths, but
-- Review Queue chips and reviewer hints resolve from task_type lookup metadata
-- plus task_type_catalog settings. Keep the repair row-driven and idempotent.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605301430_console_v2_marketing_lead_followup_review_metadata_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  organization_id,
  scope_type
)
VALUES (
  'task_type',
  'Canonical task type taxonomy with Console V2 tone and reviewer-description metadata.',
  'operations',
  'tier_2',
  FALSE,
  NULL,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

WITH task_type_seed(value, label, sort_order, tone, reviewer_description, metadata) AS (
  VALUES (
    'marketing_lead_followup',
    'Marketing lead follow-up',
    35,
    'info',
    'Follow up on inbound Contact Sales leads from Landing. Review captured company, contact, request context, and workflow lineage before completing or reassigning the task.',
    jsonb_build_object(
      'console_path', '/workflows/review-queue',
      'console_focus_param', 'focus',
      'console_focus_source', 'id'
    )
  )
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  status,
  metadata
)
SELECT
  ld.id,
  seed.value,
  seed.label,
  seed.sort_order,
  'active',
  seed.metadata || jsonb_build_object(
    'tone', seed.tone,
    'reviewer_description', seed.reviewer_description
  )
FROM public.lookup_definitions ld
CROSS JOIN task_type_seed seed
WHERE ld.category = 'task_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_version_id UUID;
  v_value JSONB;
  v_task_types JSONB;
  v_next_task_types JSONB := '[]'::jsonb;
  v_item JSONB;
  v_seen BOOLEAN := FALSE;
  v_key TEXT := 'marketing_lead_followup';
  v_patch JSONB := jsonb_build_object(
    'key', 'marketing_lead_followup',
    'name', 'Marketing lead follow-up',
    'description', 'Follow up on inbound Contact Sales leads from Landing. Review captured company, contact, request context, and workflow lineage before completing or reassigning the task.',
    'default_priority', 50,
    'default_queue_key', 'default',
    'enabled', TRUE,
    'tone', 'info',
    'reviewer_description', 'Follow up on inbound Contact Sales leads from Landing. Review captured company, contact, request context, and workflow lineage before completing or reassigning the task.'
  );
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_value
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'marketing_lead_followup_review_metadata_v1: global task_type_catalog settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_task_types := COALESCE(v_value->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) IS DISTINCT FROM 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_task_types)
  LOOP
    IF lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), '')) = v_key THEN
      v_item := COALESCE(v_item, '{}'::jsonb) || v_patch;
      v_seen := TRUE;
    END IF;
    v_next_task_types := v_next_task_types || jsonb_build_array(v_item);
  END LOOP;

  IF NOT v_seen THEN
    v_next_task_types := v_next_task_types || jsonb_build_array(v_patch);
  END IF;

  v_value := jsonb_set(COALESCE(v_value, '{}'::jsonb), '{task_types}', v_next_task_types, TRUE);
  IF NULLIF(btrim(COALESCE(v_value->>'version', '')), '') IS NULL THEN
    v_value := jsonb_set(v_value, '{version}', to_jsonb(1), TRUE);
  END IF;

  UPDATE public.settings_versions sv
     SET value = v_value,
         approved_at = COALESCE(sv.approved_at, now()),
         updated_at = now()
   WHERE sv.id = v_settings_version_id;

  UPDATE public.settings s
     SET cached_value = v_value,
         last_updated = now()
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605301430_console_v2_marketing_lead_followup_review_metadata_v1'));
COMMIT;
