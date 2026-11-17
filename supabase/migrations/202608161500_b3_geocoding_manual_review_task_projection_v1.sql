-- Migration: Geocoding manual review Tasks SSOT projection
-- Purpose:
--   - Project pending geocoding manual-review rows into canonical public.tasks.
--   - Keep task defaults and terminal outcome mapping row-driven through task_type_catalog/task_types.
--   - Close the source manual-review row, with decision lineage, when its canonical task terminates.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607151230_geocoding_manual_review_task_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Append a global task_type_catalog version through the canonical helper.
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_current JSONB := NULL;
  v_task_types JSONB := '[]'::jsonb;
  v_next_task_types JSONB := '[]'::jsonb;
  v_item JSONB;
  v_item_metadata JSONB := '{}'::jsonb;
  v_item_assignment_defaults JSONB := '{}'::jsonb;
  v_seen BOOLEAN := FALSE;
  v_desired JSONB := jsonb_build_object(
    'key', 'geocoding_manual_review',
    'name', 'Geocoding Manual Review',
    'description', 'Operator review for low-confidence address geocoding outcomes.',
    'default_priority', 50,
    'default_queue_key', 'address_ops',
    'enabled', TRUE,
    'metadata', jsonb_build_object(
      'assignment_defaults', jsonb_build_object(
        'queue_key', 'address_ops',
        'sla_minutes', 60
      ),
      'manual_review_projection', jsonb_build_object(
        'source_task_types', jsonb_build_array('geocoding', 'geocoding_auto_learn'),
        'review_queue_resource', 'tasks',
        'terminal_status_outcomes', jsonb_build_object(
          'completed', 'resolved',
          'exception', 'rejected',
          'rejected', 'rejected',
          'canceled', 'canceled',
          'cancelled', 'canceled'
        )
      ),
      'reviewer_description', 'Review low-confidence address geocoding and record the canonical decision.',
      'tone', 'info'
    )
  );
BEGIN
  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1
   FOR UPDATE;

  IF v_current IS NULL OR jsonb_typeof(v_current) <> 'object' THEN
    RAISE EXCEPTION 'geocoding_manual_review_task_projection_v1 requires global task_type_catalog settings'
      USING ERRCODE = '23514';
  END IF;

  v_task_types := COALESCE(v_current->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) <> 'array' THEN
    RAISE EXCEPTION 'geocoding_manual_review_task_projection_v1 requires task_type_catalog.task_types array'
      USING ERRCODE = '23514';
  END IF;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_task_types)
  LOOP
    IF lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), '')) = 'geocoding_manual_review' THEN
      v_seen := TRUE;
      v_item_metadata := COALESCE(v_item->'metadata', '{}'::jsonb);
      IF jsonb_typeof(v_item_metadata) <> 'object' THEN
        v_item_metadata := '{}'::jsonb;
      END IF;

      v_item_assignment_defaults := COALESCE(v_item_metadata->'assignment_defaults', '{}'::jsonb);
      IF jsonb_typeof(v_item_assignment_defaults) <> 'object' THEN
        v_item_assignment_defaults := '{}'::jsonb;
      END IF;

      v_item := v_item || (v_desired - 'metadata');
      v_item_metadata := v_item_metadata || (v_desired->'metadata' - 'assignment_defaults');
      v_item_metadata := jsonb_set(
        v_item_metadata,
        '{assignment_defaults}',
        v_item_assignment_defaults || (v_desired#>'{metadata,assignment_defaults}'),
        TRUE
      );
      v_item := jsonb_set(v_item, '{metadata}', v_item_metadata, TRUE);
    END IF;

    v_next_task_types := v_next_task_types || jsonb_build_array(v_item);
  END LOOP;

  IF NOT v_seen THEN
    v_next_task_types := v_next_task_types || jsonb_build_array(v_desired);
  END IF;

  v_current := jsonb_set(v_current, '{task_types}', v_next_task_types, TRUE);

  IF v_next_task_types IS DISTINCT FROM v_task_types THEN
    PERFORM public.upsert_settings_value_v1(
      'task_type_catalog',
      'global',
      NULL::uuid,
      v_current,
      1,
      'Add geocoding manual review Tasks SSOT projection'
    );
  END IF;
END;
$do$;

-- Repair any pre-existing organization task type without replacing tenant-specific
-- queue/SLA overrides. The canonical projection mapping itself is not overrideable.
DO $do$
DECLARE
  v_catalog_entry JSONB := NULL;
  v_catalog_metadata JSONB := '{}'::jsonb;
  v_catalog_assignment_defaults JSONB := '{}'::jsonb;
  v_catalog_projection JSONB := '{}'::jsonb;
BEGIN
  SELECT elem.value
    INTO v_catalog_entry
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS elem(value)
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND lower(NULLIF(btrim(COALESCE(elem.value->>'key', '')), '')) = 'geocoding_manual_review'
   LIMIT 1;

  IF v_catalog_entry IS NULL THEN
    RAISE EXCEPTION 'geocoding_manual_review_task_projection_v1 catalog entry missing after append'
      USING ERRCODE = '23514';
  END IF;

  v_catalog_metadata := COALESCE(v_catalog_entry->'metadata', '{}'::jsonb);
  v_catalog_assignment_defaults := COALESCE(v_catalog_metadata->'assignment_defaults', '{}'::jsonb);
  v_catalog_projection := COALESCE(v_catalog_metadata->'manual_review_projection', '{}'::jsonb);

  UPDATE public.task_types tt
     SET name = COALESCE(NULLIF(btrim(tt.name), ''), v_catalog_entry->>'name'),
         description = COALESCE(NULLIF(btrim(tt.description), ''), v_catalog_entry->>'description'),
         enabled = TRUE,
         default_queue_key = CASE
           WHEN NULLIF(btrim(COALESCE(tt.default_queue_key, '')), '') IS NULL
             OR lower(tt.default_queue_key) = 'default'
             THEN v_catalog_entry->>'default_queue_key'
           ELSE tt.default_queue_key
         END,
         metadata = jsonb_set(
           jsonb_set(
             CASE
               WHEN jsonb_typeof(tt.metadata) = 'object' THEN tt.metadata
               ELSE '{}'::jsonb
             END || (v_catalog_metadata - 'assignment_defaults' - 'manual_review_projection'),
             '{assignment_defaults}',
             v_catalog_assignment_defaults || CASE
               WHEN jsonb_typeof(tt.metadata->'assignment_defaults') = 'object'
                 THEN tt.metadata->'assignment_defaults'
               ELSE '{}'::jsonb
             END,
             TRUE
           ),
           '{manual_review_projection}',
           v_catalog_projection,
           TRUE
         ),
         updated_at = workflow_now()
   WHERE tt.key = 'geocoding_manual_review';
END;
$do$;

-------------------------------------------------------------------------------
-- 2) Project a source manual-review row through create_task_system_v1.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.geocoding_manual_review_queue_task_sync_v1(
  p_manual_review_task_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_review public.manual_review_tasks%ROWTYPE;
  v_canonical_review public.manual_review_tasks%ROWTYPE;
  v_catalog_projection JSONB := '{}'::jsonb;
  v_effective_projection JSONB := '{}'::jsonb;
  v_context JSONB := '{}'::jsonb;
  v_identity JSONB := '{}'::jsonb;
  v_task_type_id UUID := NULL;
  v_task_id UUID := NULL;
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_idempotency_key TEXT := NULL;
  v_existing_task public.tasks%ROWTYPE;
BEGIN
  IF p_manual_review_task_id IS NULL THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 requires manual_review_task_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_review
    FROM public.manual_review_tasks mrt
   WHERE mrt.id = p_manual_review_task_id
     AND mrt.status IN ('pending', 'assigned');

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(elem.value#>'{metadata,manual_review_projection}', '{}'::jsonb)
    INTO v_catalog_projection
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS elem(value)
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND lower(NULLIF(btrim(COALESCE(elem.value->>'key', '')), '')) = 'geocoding_manual_review'
   LIMIT 1;

  IF jsonb_typeof(v_catalog_projection->'source_task_types') <> 'array'
     OR NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(v_catalog_projection->'source_task_types') AS source_type(value)
        WHERE lower(source_type.value) = lower(v_review.task_type)
     ) THEN
    RETURN NULL;
  END IF;

  IF v_review.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.clients c
     WHERE c.id = v_review.client_id
       AND c.organization_id = v_review.organization_id
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 client lineage mismatch for source %', v_review.id
      USING ERRCODE = '23514';
  END IF;

  IF v_review.sender_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_review.sender_id
       AND s.client_id IS NOT DISTINCT FROM v_review.client_id
       AND c.organization_id = v_review.organization_id
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 sender lineage mismatch for source %', v_review.id
      USING ERRCODE = '23514';
  END IF;

  IF v_review.address_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.addresses a
     WHERE a.id = v_review.address_id
       AND a.organization_id = v_review.organization_id
       AND a.client_id IS NOT DISTINCT FROM v_review.client_id
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 address lineage mismatch for source %', v_review.id
      USING ERRCODE = '23514';
  END IF;

  IF v_review.shipment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.shipments sh
     WHERE sh.id = v_review.shipment_id
       AND sh.organization_id = v_review.organization_id
       AND sh.client_id IS NOT DISTINCT FROM v_review.client_id
       AND sh.sender_id IS NOT DISTINCT FROM v_review.sender_id
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 shipment lineage mismatch for source %', v_review.id
      USING ERRCODE = '23514';
  END IF;

  v_resource_type := COALESCE(
    NULLIF(lower(btrim(COALESCE(v_review.resource_type, ''))), ''),
    CASE
      WHEN v_review.address_id IS NOT NULL THEN 'address'
      WHEN v_review.shipment_id IS NOT NULL THEN 'shipment'
      ELSE 'manual_review_task'
    END
  );
  v_resource_id := COALESCE(v_review.resource_id, v_review.address_id, v_review.shipment_id, v_review.id);

  IF v_resource_type = 'address' AND NOT EXISTS (
    SELECT 1 FROM public.addresses a
     WHERE a.id = v_resource_id
       AND a.organization_id = v_review.organization_id
       AND a.client_id IS NOT DISTINCT FROM v_review.client_id
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 resource address lineage mismatch for source %', v_review.id
      USING ERRCODE = '23514';
  ELSIF v_resource_type = 'shipment' AND NOT EXISTS (
    SELECT 1 FROM public.shipments sh
     WHERE sh.id = v_resource_id
       AND sh.organization_id = v_review.organization_id
       AND sh.client_id IS NOT DISTINCT FROM v_review.client_id
       AND sh.sender_id IS NOT DISTINCT FROM v_review.sender_id
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 resource shipment lineage mismatch for source %', v_review.id
      USING ERRCODE = '23514';
  ELSIF v_resource_type = 'manual_review_task' AND v_resource_id IS DISTINCT FROM v_review.id THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 manual-review resource mismatch for source %', v_review.id
      USING ERRCODE = '23514';
  ELSIF v_resource_type NOT IN ('address', 'shipment', 'manual_review_task') THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 unsupported resource type % for source %', v_resource_type, v_review.id
      USING ERRCODE = '23514';
  END IF;

  v_identity := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_review.organization_id,
    'client_id', v_review.client_id,
    'sender_id', v_review.sender_id,
    'source_task_type', lower(v_review.task_type),
    'resource_type', v_resource_type,
    'resource_id', v_resource_id,
    'reason', lower(NULLIF(btrim(COALESCE(v_review.reason, '')), ''))
  ));

  -- Serialize one active review identity so concurrent duplicate inserts converge on
  -- the same earliest source generation and therefore the same task idempotency key.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_identity::text, 0));

  SELECT mrt.*
    INTO v_canonical_review
    FROM public.manual_review_tasks mrt
   WHERE mrt.status IN ('pending', 'assigned')
     AND mrt.organization_id = v_review.organization_id
     AND mrt.client_id IS NOT DISTINCT FROM v_review.client_id
     AND mrt.sender_id IS NOT DISTINCT FROM v_review.sender_id
     AND lower(mrt.task_type) = lower(v_review.task_type)
     AND lower(NULLIF(btrim(COALESCE(mrt.reason, '')), '')) IS NOT DISTINCT FROM lower(NULLIF(btrim(COALESCE(v_review.reason, '')), ''))
     AND COALESCE(
       NULLIF(lower(btrim(COALESCE(mrt.resource_type, ''))), ''),
       CASE
         WHEN mrt.address_id IS NOT NULL THEN 'address'
         WHEN mrt.shipment_id IS NOT NULL THEN 'shipment'
         ELSE 'manual_review_task'
       END
     ) = v_resource_type
     AND COALESCE(mrt.resource_id, mrt.address_id, mrt.shipment_id, mrt.id) = v_resource_id
   ORDER BY mrt.created_at, mrt.id
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_idempotency_key := 'geocoding-manual-review:' || v_canonical_review.id::text;

  v_context := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_canonical_review.organization_id,
    'client_id', v_canonical_review.client_id,
    'sender_id', v_canonical_review.sender_id,
    'address_id', v_canonical_review.address_id,
    'shipment_id', v_canonical_review.shipment_id,
    'manual_review_task_id', v_canonical_review.id,
    'source_manual_review_task_type', v_canonical_review.task_type,
    'manual_review_reason', v_canonical_review.reason
  ));

  v_task_type_id := public.ensure_task_type_from_catalog_internal_v1(
    v_canonical_review.organization_id,
    'geocoding_manual_review',
    v_context
  );

  IF v_task_type_id IS NULL THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 could not provision geocoding_manual_review task type'
      USING ERRCODE = '23514';
  END IF;

  -- Projection eligibility/outcomes are global platform contract. Tenant catalog
  -- scopes may still override assignment defaults, but cannot disable or rewrite it.
  UPDATE public.task_types tt
     SET enabled = TRUE,
         metadata = jsonb_set(
           CASE WHEN jsonb_typeof(tt.metadata) = 'object' THEN tt.metadata ELSE '{}'::jsonb END,
           '{manual_review_projection}',
           v_catalog_projection,
           TRUE
         ),
         updated_at = workflow_now()
   WHERE tt.id = v_task_type_id;

  v_effective_projection := v_catalog_projection;

  IF jsonb_typeof(v_effective_projection->'source_task_types') <> 'array'
     OR NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(v_effective_projection->'source_task_types') AS source_type(value)
        WHERE lower(source_type.value) = lower(v_review.task_type)
     ) THEN
    RETURN NULL;
  END IF;

  SELECT t.*
    INTO v_existing_task
    FROM public.tasks t
   WHERE t.organization_id = v_canonical_review.organization_id
     AND t.idempotency_key = v_idempotency_key
   LIMIT 1;

  IF FOUND AND (
    v_existing_task.task_type_id IS DISTINCT FROM v_task_type_id
    OR v_existing_task.client_id IS DISTINCT FROM v_canonical_review.client_id
    OR v_existing_task.sender_id IS DISTINCT FROM v_canonical_review.sender_id
    OR v_existing_task.resource_type IS DISTINCT FROM v_resource_type
    OR v_existing_task.resource_id IS DISTINCT FROM v_resource_id
    OR v_existing_task.metadata->>'manual_review_task_id' IS DISTINCT FROM v_canonical_review.id::text
    OR v_existing_task.metadata->'manual_review_identity' IS DISTINCT FROM v_identity
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 idempotency collision mismatch for source % task %', v_canonical_review.id, v_existing_task.id
      USING ERRCODE = '23514';
  END IF;

  SELECT created.task_id
    INTO v_task_id
    FROM public.create_task_system_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'task_type_key', 'geocoding_manual_review',
        'context', v_context,
        'resource_type', v_resource_type,
        'resource_id', v_resource_id,
        'queue_key', NULLIF(btrim(COALESCE(v_canonical_review.queue_assignment, '')), ''),
        'sla_minutes', v_canonical_review.sla_minutes,
        'idempotency_key', v_idempotency_key,
        'metadata', jsonb_strip_nulls(COALESCE(v_canonical_review.metadata, '{}'::jsonb) || jsonb_build_object(
          'manual_review_task_id', v_canonical_review.id,
          'source_manual_review_task_type', v_canonical_review.task_type,
          'address_id', v_canonical_review.address_id,
          'shipment_id', v_canonical_review.shipment_id,
          'manual_review_reason', v_canonical_review.reason,
          'manual_review_identity', v_identity,
          'review_queue_resource', 'tasks',
          'manual_review_projection', v_effective_projection
        )),
        'actor_system', 'geocoding_manual_review_queue_task_sync_v1'
      ))
    ) AS created
   LIMIT 1;

  IF v_task_id IS NULL THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 create_task_system_v1 returned no task'
      USING ERRCODE = '23514';
  END IF;

  SELECT t.*
    INTO v_existing_task
    FROM public.tasks t
   WHERE t.id = v_task_id;

  IF NOT FOUND OR v_existing_task.organization_id IS DISTINCT FROM v_canonical_review.organization_id
    OR v_existing_task.task_type_id IS DISTINCT FROM v_task_type_id
    OR v_existing_task.idempotency_key IS DISTINCT FROM v_idempotency_key
    OR v_existing_task.client_id IS DISTINCT FROM v_canonical_review.client_id
    OR v_existing_task.sender_id IS DISTINCT FROM v_canonical_review.sender_id
    OR v_existing_task.resource_type IS DISTINCT FROM v_resource_type
    OR v_existing_task.resource_id IS DISTINCT FROM v_resource_id
    OR v_existing_task.metadata->>'manual_review_task_id' IS DISTINCT FROM v_canonical_review.id::text
    OR v_existing_task.metadata->'manual_review_identity' IS DISTINCT FROM v_identity THEN
    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 created task lineage mismatch for source % task %', v_canonical_review.id, v_task_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.manual_review_tasks mrt
     SET metadata = jsonb_strip_nulls(COALESCE(mrt.metadata, '{}'::jsonb) || jsonb_build_object(
           'operator_task_id', v_task_id,
           'manual_review_canonical_source_id', v_canonical_review.id,
           'manual_review_identity', v_identity,
           'operator_task_type_key', 'geocoding_manual_review',
           'review_queue_resource', 'tasks'
         )),
         updated_at = workflow_now()
   WHERE mrt.id IN (v_review.id, v_canonical_review.id)
     AND (
       COALESCE(mrt.metadata->>'operator_task_id', '') IS DISTINCT FROM v_task_id::text
       OR COALESCE(mrt.metadata->>'manual_review_canonical_source_id', '') IS DISTINCT FROM v_canonical_review.id::text
       OR mrt.metadata->'manual_review_identity' IS DISTINCT FROM v_identity
       OR COALESCE(mrt.metadata->>'operator_task_type_key', '') IS DISTINCT FROM 'geocoding_manual_review'
       OR COALESCE(mrt.metadata->>'review_queue_resource', '') IS DISTINCT FROM 'tasks'
     );

  RETURN v_task_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.geocoding_manual_review_queue_task_sync_trigger_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NEW.status IN ('pending', 'assigned') THEN
    PERFORM public.geocoding_manual_review_queue_task_sync_v1(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_geocoding_manual_review_queue_task_sync_v1 ON public.manual_review_tasks;
CREATE TRIGGER trg_geocoding_manual_review_queue_task_sync_v1
  AFTER INSERT OR UPDATE OF task_type, status
  ON public.manual_review_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.geocoding_manual_review_queue_task_sync_trigger_v1();

-------------------------------------------------------------------------------
-- 3) Resolve source manual-review truth from canonical task terminal state.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.geocoding_manual_review_operator_task_resolve_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_task_type_key TEXT := NULL;
  v_projection JSONB := '{}'::jsonb;
  v_manual_review_task_id UUID := NULL;
  v_outcome TEXT := NULL;
  v_primary_review public.manual_review_tasks%ROWTYPE;
  v_review public.manual_review_tasks%ROWTYPE;
  v_task_identity JSONB := NULL;
  v_review_identity JSONB := NULL;
  v_review_resource_type TEXT := NULL;
  v_review_resource_id UUID := NULL;
  v_expected_idempotency_key TEXT := NULL;
  v_decision_id UUID := NULL;
  v_resolution_notes TEXT := NULL;
BEGIN
  IF TG_OP <> 'UPDATE' OR lower(COALESCE(NEW.status, '')) IS NOT DISTINCT FROM lower(COALESCE(OLD.status, '')) THEN
    RETURN NEW;
  END IF;

  SELECT tt.key, COALESCE(tt.metadata->'manual_review_projection', '{}'::jsonb)
    INTO v_task_type_key, v_projection
    FROM public.task_types tt
   WHERE tt.id = NEW.task_type_id
     AND tt.organization_id = NEW.organization_id;

  IF v_task_type_key IS DISTINCT FROM 'geocoding_manual_review' THEN
    RETURN NEW;
  END IF;

  v_outcome := lower(NULLIF(
    btrim(COALESCE(v_projection#>>ARRAY['terminal_status_outcomes', lower(NEW.status)], '')),
    ''
  ));

  IF v_outcome IS NULL OR v_outcome NOT IN ('resolved', 'rejected', 'canceled') THEN
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

  SELECT *
    INTO v_primary_review
    FROM public.manual_review_tasks mrt
   WHERE mrt.id = v_manual_review_task_id
     AND mrt.organization_id = NEW.organization_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_task_identity := NEW.metadata->'manual_review_identity';
  v_expected_idempotency_key := 'geocoding-manual-review:' || v_primary_review.id::text;
  v_review_resource_type := COALESCE(
    NULLIF(lower(btrim(COALESCE(v_primary_review.resource_type, ''))), ''),
    CASE
      WHEN v_primary_review.address_id IS NOT NULL THEN 'address'
      WHEN v_primary_review.shipment_id IS NOT NULL THEN 'shipment'
      ELSE 'manual_review_task'
    END
  );
  v_review_resource_id := COALESCE(
    v_primary_review.resource_id,
    v_primary_review.address_id,
    v_primary_review.shipment_id,
    v_primary_review.id
  );

  IF v_primary_review.metadata->>'operator_task_id' IS DISTINCT FROM NEW.id::text
     OR v_primary_review.metadata->>'manual_review_canonical_source_id' IS DISTINCT FROM v_primary_review.id::text
  THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_task_identity) IS DISTINCT FROM 'object'
     OR v_primary_review.metadata->'manual_review_identity' IS DISTINCT FROM v_task_identity
     OR NEW.idempotency_key IS DISTINCT FROM v_expected_idempotency_key
     OR NEW.client_id IS DISTINCT FROM v_primary_review.client_id
     OR NEW.sender_id IS DISTINCT FROM v_primary_review.sender_id
     OR NEW.resource_type IS DISTINCT FROM v_review_resource_type
     OR NEW.resource_id IS DISTINCT FROM v_review_resource_id THEN
    RAISE EXCEPTION 'geocoding_manual_review_operator_task_resolve_v1 canonical task lineage mismatch for task % source %', NEW.id, v_primary_review.id
      USING ERRCODE = '23514';
  END IF;

  IF v_review_resource_type = 'address' AND NOT EXISTS (
    SELECT 1 FROM public.addresses a
     WHERE a.id = v_review_resource_id
       AND a.organization_id = v_primary_review.organization_id
       AND a.client_id IS NOT DISTINCT FROM v_primary_review.client_id
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_operator_task_resolve_v1 address lineage mismatch for task % source %', NEW.id, v_primary_review.id
      USING ERRCODE = '23514';
  ELSIF v_review_resource_type = 'shipment' AND NOT EXISTS (
    SELECT 1 FROM public.shipments sh
     WHERE sh.id = v_review_resource_id
       AND sh.organization_id = v_primary_review.organization_id
       AND sh.client_id IS NOT DISTINCT FROM v_primary_review.client_id
       AND sh.sender_id IS NOT DISTINCT FROM v_primary_review.sender_id
  ) THEN
    RAISE EXCEPTION 'geocoding_manual_review_operator_task_resolve_v1 shipment lineage mismatch for task % source %', NEW.id, v_primary_review.id
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_projection->'source_task_types') <> 'array'
     OR NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(v_projection->'source_task_types') AS source_type(value)
        WHERE lower(source_type.value) = lower(v_primary_review.task_type)
     ) THEN
    RETURN NEW;
  END IF;

  v_resolution_notes := COALESCE(
    NULLIF(btrim(COALESCE(NEW.status_reason, '')), ''),
    format('Resolved from canonical task status %s', NEW.status)
  );

  FOR v_review IN
    SELECT mrt.*
      FROM public.manual_review_tasks mrt
     WHERE mrt.organization_id = NEW.organization_id
       AND mrt.status IN ('pending', 'assigned', 'escalated')
       AND mrt.metadata->>'operator_task_id' = NEW.id::text
       AND mrt.metadata->>'manual_review_canonical_source_id' = v_primary_review.id::text
     ORDER BY mrt.created_at, mrt.id
     FOR UPDATE
  LOOP
    v_review_resource_type := COALESCE(
      NULLIF(lower(btrim(COALESCE(v_review.resource_type, ''))), ''),
      CASE
        WHEN v_review.address_id IS NOT NULL THEN 'address'
        WHEN v_review.shipment_id IS NOT NULL THEN 'shipment'
        ELSE 'manual_review_task'
      END
    );
    v_review_resource_id := COALESCE(v_review.resource_id, v_review.address_id, v_review.shipment_id, v_review.id);
    v_review_identity := jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_review.organization_id,
      'client_id', v_review.client_id,
      'sender_id', v_review.sender_id,
      'source_task_type', lower(v_review.task_type),
      'resource_type', v_review_resource_type,
      'resource_id', v_review_resource_id,
      'reason', lower(NULLIF(btrim(COALESCE(v_review.reason, '')), ''))
    ));

    IF v_review.metadata->'manual_review_identity' IS DISTINCT FROM v_task_identity
       OR v_review_identity IS DISTINCT FROM v_task_identity
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(v_projection->'source_task_types') AS source_type(value)
          WHERE lower(source_type.value) = lower(v_review.task_type)
       ) THEN
      RAISE EXCEPTION 'geocoding_manual_review_operator_task_resolve_v1 linked source lineage mismatch for task % source %', NEW.id, v_review.id
        USING ERRCODE = '23514';
    END IF;

    v_decision_id := public.log_decision(
      p_organization_id := v_review.organization_id,
      p_decision_category := 'manual_review',
      p_resource_type := 'manual_review_task',
      p_resource_id := v_review.id,
      p_decision_point := 'resolve_from_canonical_task',
      p_decision_outcome := v_outcome,
      p_performed_by_system := 'geocoding_manual_review_operator_task_resolve_v1',
      p_correlation_id := public.current_correlation_id(),
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'operator_task_id', NEW.id,
        'operator_task_from_status', OLD.status,
        'operator_task_to_status', NEW.status,
        'operator_task_status_reason', NEW.status_reason,
        'task_type_key', v_task_type_key,
        'source_manual_review_task_type', v_review.task_type,
        'address_id', v_review.address_id,
        'shipment_id', v_review.shipment_id,
        'resource_type', v_review.resource_type,
        'resource_id', v_review.resource_id
      )),
      p_decision_reason := v_resolution_notes
    );

    UPDATE public.manual_review_tasks mrt
       SET status = 'resolved',
           resolution_outcome = v_outcome,
           resolution_notes = v_resolution_notes,
           resolved_by = auth.uid(),
           resolved_at = statement_timestamp(),
           metadata = jsonb_strip_nulls(COALESCE(mrt.metadata, '{}'::jsonb) || jsonb_build_object(
             'operator_task_id', NEW.id,
             'operator_task_status', NEW.status,
             'operator_task_status_reason', NEW.status_reason,
             'operator_task_type_key', v_task_type_key,
             'operator_resolution_decision_id', v_decision_id,
             'review_queue_resource', 'tasks'
           )),
           updated_at = workflow_now()
     WHERE mrt.id = v_review.id
       AND mrt.status IN ('pending', 'assigned', 'escalated');
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_geocoding_manual_review_operator_task_resolve_v1 ON public.tasks;
CREATE TRIGGER trg_geocoding_manual_review_operator_task_resolve_v1
  AFTER UPDATE OF status, status_reason
  ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.geocoding_manual_review_operator_task_resolve_v1();

-------------------------------------------------------------------------------
-- 4) Backfill current pending rows through the same canonical sync function.
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_review_id UUID;
BEGIN
  FOR v_review_id IN
    SELECT mrt.id
      FROM public.manual_review_tasks mrt
     WHERE mrt.status IN ('pending', 'assigned')
     ORDER BY mrt.created_at, mrt.id
  LOOP
    PERFORM public.geocoding_manual_review_queue_task_sync_v1(v_review_id);
  END LOOP;
END;
$do$;

COMMENT ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID)
  IS 'Service-only create-once projection of configured geocoding manual-review rows into canonical tasks; active duplicate identities serialize onto the earliest source generation and validated idempotency lineage.';
COMMENT ON FUNCTION public.geocoding_manual_review_queue_task_sync_trigger_v1()
  IS 'Projects newly eligible manual-review rows into Tasks SSOT; post-projection queue, SLA, resource, and metadata changes belong to the canonical task.';
COMMENT ON FUNCTION public.geocoding_manual_review_operator_task_resolve_v1()
  IS 'Resolves reciprocally linked same-organization geocoding manual-review sources from row-driven canonical task terminal outcomes and records decision lineage.';

REVOKE ALL ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.geocoding_manual_review_queue_task_sync_trigger_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.geocoding_manual_review_queue_task_sync_trigger_v1() TO service_role;

REVOKE ALL ON FUNCTION public.geocoding_manual_review_operator_task_resolve_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.geocoding_manual_review_operator_task_resolve_v1() TO service_role;

SELECT pg_advisory_unlock(hashtext('202607151230_geocoding_manual_review_task_projection_v1'));

COMMIT;
