-- Plan: PLAN-202604-production-readiness-coverage-closure / Step: restore missing lookup and settings contracts
-- Purpose:
--   - Keep global settings defaults schema-valid after registry normalization.
--   - Keep branch lookup resources capability-declared for registry schema checks.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('20261122029015_local_verification_contract_reconcile_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- task_status: workflow-created task transitions are lookup-addressable.
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'task_status',
  'Canonical task lifecycle status values used by public.transition_task_v1.',
  'operations',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, '{}'::jsonb
  FROM public.lookup_definitions ld
  CROSS JOIN (
    VALUES
      ('pending', 'Pending', 'Task has been created and is awaiting work.', 10, TRUE),
      ('assigned', 'Assigned', 'Task has an assigned owner.', 20, FALSE),
      ('in_progress', 'In progress', 'Task work has started.', 30, FALSE),
      ('blocked', 'Blocked', 'Task cannot progress until a dependency clears.', 40, FALSE),
      ('completed', 'Completed', 'Task finished successfully.', 50, FALSE),
      ('canceled', 'Canceled', 'Task was canceled before completion.', 60, FALSE)
  ) AS v(value, label, description, sort_order, is_default)
 WHERE ld.category = 'task_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- geocoding_policy: auto_learning combines base behavior and alias knobs.
-------------------------------------------------------------------------------

UPDATE public.schema_registry
   SET schema = jsonb_set(
     schema,
     '{properties,auto_learning}',
     jsonb_set(
       schema#>'{properties,auto_learning}',
       '{properties}',
       jsonb_build_object(
         'alias_confidence_min', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
         'alias_review_threshold', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 1),
         'alias_max_per_run', jsonb_build_object('type', 'integer', 'minimum', 0)
       ) || COALESCE(schema#>'{properties,auto_learning,properties}', '{}'::jsonb)
     ),
     TRUE
   ),
       updated_at = now()
 WHERE category = 'geocoding_policy'
   AND is_active = TRUE
   AND jsonb_typeof(schema#>'{properties,auto_learning}') = 'object';

-------------------------------------------------------------------------------
-- ui_read_registry: branches is lookup/read-only, but still needs a read cap.
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_next_resources JSONB;
  v_resource JSONB;
  v_next JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.schema_version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'ui_read_registry'
    ORDER BY s.id
    FOR UPDATE OF s, sv
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_next_resources := '[]'::jsonb;

    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_resource->>'key' = 'branches' THEN
        v_resource := COALESCE(v_resource, '{}'::jsonb)
          || jsonb_build_object(
            'capability_read', COALESCE(NULLIF(v_resource->>'capability_read', ''), 'shipments.read')
          );
      END IF;

      v_next_resources := v_next_resources || jsonb_build_array(v_resource);
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', v_row.scope_type, v_row.scope_id,
        v_next, v_row.schema_version, 'Declare branches ui_read_registry read capability for lookup forms.'
      );
    END IF;
  END LOOP;
END;
$do$;

COMMIT;
