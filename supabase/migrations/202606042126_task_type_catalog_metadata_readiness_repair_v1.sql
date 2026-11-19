-- Repair canonical task-review metadata and default action rows used by Console V2.
-- Keeps review queue behavior row-driven through lookup_values + task_type_catalog.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202606042126_task_type_catalog_metadata_readiness_repair_v1'));

UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'tone', 'info',
                       'reviewer_description',
                       'Inbound tenant signup request. Verify business name, billing details, and KYC docs before approval.'
                     ),
       updated_at = now()
  FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'task_type'
   AND lv.value = 'tenant_signup_review'
   AND (
     lv.metadata IS NULL
     OR (lv.metadata -> 'tone') IS NULL
     OR (lv.metadata -> 'reviewer_description') IS NULL
   );

DO $do$
DECLARE
  v_items jsonb := jsonb_build_array(
    jsonb_build_object(
      'key', 'manual_review',
      'name', 'Manual review',
      'description', 'Manual review required. Workflow paused awaiting reviewer decision.',
      'default_priority', 30,
      'default_queue_key', 'manual_review',
      'default_actions', jsonb_build_array('approve', 'decline', 'escalate'),
      'enabled', true,
      'metadata', jsonb_build_object(
        'allowed_actions', jsonb_build_array('approve', 'decline', 'escalate'),
        'console_path', '/workflows/review-queue',
        'console_focus_param', 'focus',
        'console_focus_source', 'id'
      )
    ),
    jsonb_build_object(
      'key', 'shipment_amend_review',
      'name', 'Shipment amend review',
      'description', 'Customer-requested shipment amendment. Validate the requested operation against amend policy.',
      'default_priority', 40,
      'default_queue_key', 'shipment_amend',
      'default_actions', jsonb_build_array('approve', 'reject'),
      'enabled', true,
      'metadata', jsonb_build_object(
        'allowed_actions', jsonb_build_array('approve', 'reject'),
        'console_path', '/operate/amend-cancel',
        'console_focus_param', 'focus',
        'console_focus_source', 'id'
      )
    )
  );
  v_row record;
  v_value jsonb;
  v_task_types jsonb;
  v_next_task_types jsonb;
  v_item jsonb;
  v_change_reason text := 'Repair Console V2 task type review actions';
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'task_type_catalog'
       AND scope_type = 'global'
       AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ) THEN
    RAISE EXCEPTION 'task type catalog is not available'
      USING ERRCODE = '23503';
  END IF;

  FOR v_row IN
    SELECT id, settings_version_id, COALESCE(cached_value, '{}'::jsonb) AS cached_value
      FROM public.settings
     WHERE category = 'task_type_catalog'
       AND scope_type = 'global'
       AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  LOOP
    v_value := CASE
      WHEN jsonb_typeof(v_row.cached_value) = 'object' THEN v_row.cached_value
      ELSE '{}'::jsonb
    END;

    v_task_types := COALESCE(v_value -> 'task_types', '[]'::jsonb);
    IF jsonb_typeof(v_task_types) <> 'array' THEN
      v_task_types := '[]'::jsonb;
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_items)
    LOOP
      IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_task_types) AS existing(value)
         WHERE lower(NULLIF(btrim(COALESCE(existing.value ->> 'key', '')), ''))
               = lower(v_item ->> 'key')
      ) THEN
        SELECT COALESCE(
                 jsonb_agg(
                   CASE
                     WHEN lower(NULLIF(btrim(COALESCE(existing.value ->> 'key', '')), ''))
                          = lower(v_item ->> 'key')
                       THEN existing.value
                            || jsonb_build_object(
                                 'default_actions', v_item -> 'default_actions',
                                 'metadata', COALESCE(existing.value -> 'metadata', '{}'::jsonb)
                                             || COALESCE(v_item -> 'metadata', '{}'::jsonb)
                               )
                     ELSE existing.value
                   END
                   ORDER BY existing.ordinality
                 ),
                 '[]'::jsonb
               )
          INTO v_next_task_types
          FROM jsonb_array_elements(v_task_types) WITH ORDINALITY AS existing(value, ordinality);
      ELSE
        v_next_task_types := v_task_types || jsonb_build_array(v_item);
      END IF;

      v_task_types := v_next_task_types;
    END LOOP;

    v_value := jsonb_set(v_value, '{task_types}', v_task_types, true);

    UPDATE public.settings
       SET cached_value = v_value,
           last_updated = now()
     WHERE id = v_row.id
       AND cached_value IS DISTINCT FROM v_value;

    UPDATE public.settings_versions
       SET value = v_value,
           updated_at = now(),
           approved_at = COALESCE(approved_at, now()),
           change_reason = v_change_reason
     WHERE id = v_row.settings_version_id
       AND value IS DISTINCT FROM v_value;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202606042126_task_type_catalog_metadata_readiness_repair_v1'));

COMMIT;
