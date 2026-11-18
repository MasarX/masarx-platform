-- 202605021200_w53_console_v2_strict_canonical_metadata_pack.sql
-- Backend mirror for the W34c console-v2 strict canonical-sourcing closures
-- (Cycle B real findings, 14 fixes across 7 modules + cross-cutting SSOTs).
--
-- This migration is the additive append-only backend SSOT for FE seed
-- extensions added in:
--   • apps/console-v2/src/lib/seed-raw/lookups.js
--       — circuit_state values + tones
--       — provider_health lookup_definitions + values
--       — task_type values: tone + reviewer_description metadata
--   • apps/console-v2/src/lib/seed-raw/network-zones.js
--       — canonical_districts centroid_lat / centroid_lng for the 5 RUH
--         neighborhoods rendered by operate/tracking-map.tsx
--   • apps/console-v2/src/lib/seed-raw/policies.js
--       — route_plan_thresholds.wave_promise_window_seconds
--   • apps/console-v2/src/lib/seed-raw/workflows.js
--       — workflow_templates.template_key + canonical_uuid for every row
--   • apps/console-v2/src/lib/seed-raw/domain-tasks.js
--       — task_type_catalog.default_actions per task_type
--
-- AGENTS.md alignment:
--   §1 SIMPLE/SCALABLE — every fix collapses to a single canonical row update.
--   §2 ZERO HARDCODING — removes inline tone branches, magic numbers,
--      hardcoded UUIDs, and silent fallbacks from FE module code.
--   §3 ROW-DRIVEN — visual tone, default action lists, SLA thresholds,
--      template ids, and district label coordinates all derive from rows.
--   §4 SSOT — FE consumers resolve through canonical projections /
--      lookup_values.metadata / settings_versions.value / typed accessors.
--   §5 APPEND-ONLY — additive jsonb_set + CREATE OR REPLACE; no edits to
--      historical migrations.
--
-- Cloud verification status: deferred per operator directive. Migration is
-- safe to apply when cloud verification resumes.

-- ---------------------------------------------------------------------------
-- 1) circuit_state — ensure lookup_definitions row, then backfill metadata.tone
-- ---------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, owner_role, approval_policy, is_mutable, description)
VALUES ('circuit_state', 'engineering', 'tier_1', false, 'Circuit breaker state with operator-facing tone metadata.')
ON CONFLICT (category) DO NOTHING;

-- Backfill metadata.tone for the canonical three values. Idempotent: only
-- writes when tone is currently NULL/missing, so repeated runs are no-ops.
UPDATE public.lookup_values
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('good'::text), TRUE),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'circuit_state')
  AND value = 'closed'
  AND (metadata IS NULL OR (metadata -> 'tone') IS NULL);

UPDATE public.lookup_values
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('warn'::text), TRUE),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'circuit_state')
  AND value = 'half_open'
  AND (metadata IS NULL OR (metadata -> 'tone') IS NULL);

UPDATE public.lookup_values
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('danger'::text), TRUE),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'circuit_state')
  AND value = 'open'
  AND (metadata IS NULL OR (metadata -> 'tone') IS NULL);

-- ---------------------------------------------------------------------------
-- 2) provider_health — new canonical lookup category + values
-- ---------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, owner_role, approval_policy, is_mutable, description)
VALUES ('provider_health', 'engineering', 'tier_1', false,
        'Provider health status (provider_health_logs.status) with operator-facing tone metadata.')
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status, metadata)
SELECT d.id, v.value, v.label, v.sort_order, FALSE, 'active', v.metadata
FROM public.lookup_definitions d
CROSS JOIN (VALUES
  ('healthy',   'Healthy',   10, jsonb_build_object('tone', 'good')),
  ('degraded',  'Degraded',  20, jsonb_build_object('tone', 'warn')),
  ('unhealthy', 'Unhealthy', 30, jsonb_build_object('tone', 'danger')),
  ('down',      'Down',      31, jsonb_build_object('tone', 'danger')),
  ('critical',  'Critical',  32, jsonb_build_object('tone', 'danger')),
  ('unknown',   'Unknown',   40, jsonb_build_object('tone', 'neutral'))
) AS v(value, label, sort_order, metadata)
WHERE d.category = 'provider_health'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET metadata = EXCLUDED.metadata,
      label = EXCLUDED.label,
      sort_order = EXCLUDED.sort_order,
      status = EXCLUDED.status,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- 3) task_type — backfill tone + reviewer_description metadata
-- ---------------------------------------------------------------------------
-- Operator review-queue chip tone + reviewer hint resolve from canonical
-- task_type lookup_values.metadata. Backfill is per-value with
-- jsonb_set(create-if-missing=TRUE); only writes when the key is NULL/missing.

UPDATE public.lookup_values
SET metadata = jsonb_set(
                  jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('neutral'::text), TRUE),
                  '{reviewer_description}',
                  to_jsonb('Manual review required. Workflow paused awaiting reviewer decision. Resume via transition_task_v1 with chosen next_status.'::text),
                  TRUE
                ),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'task_type')
  AND value = 'manual_review'
  AND (metadata IS NULL
       OR (metadata -> 'tone') IS NULL
       OR (metadata -> 'reviewer_description') IS NULL);

UPDATE public.lookup_values
SET metadata = jsonb_set(
                  jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('warn'::text), TRUE),
                  '{reviewer_description}',
                  to_jsonb('Driver attempted delivery and recorded a non-final outcome. Review the resolution policy ladder result and apply the chosen action via apply_dispatch_exception_resolution_v1. The decision will write to decision_log with category=ndr_resolution.'::text),
                  TRUE
                ),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'task_type')
  AND value = 'dispatch_exception_review'
  AND (metadata IS NULL
       OR (metadata -> 'tone') IS NULL
       OR (metadata -> 'reviewer_description') IS NULL);

UPDATE public.lookup_values
SET metadata = jsonb_set(
                  jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('info'::text), TRUE),
                  '{reviewer_description}',
                  to_jsonb('Inbound tenant signup request. Verify business name, billing details, and KYC docs before approval. Approval triggers tenant_signup_intake_apply_v1 + initial settings_versions seeding.'::text),
                  TRUE
                ),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'task_type')
  AND value = 'tenant_signup_review'
  AND (metadata IS NULL
       OR (metadata -> 'tone') IS NULL
       OR (metadata -> 'reviewer_description') IS NULL);

UPDATE public.lookup_values
SET metadata = jsonb_set(
                  jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('warn'::text), TRUE),
                  '{reviewer_description}',
                  to_jsonb('Customer-requested shipment amendment. Validate the requested operation against amend policy and approve or reject.'::text),
                  TRUE
                ),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'task_type')
  AND value = 'shipment_amend_review'
  AND (metadata IS NULL
       OR (metadata -> 'tone') IS NULL
       OR (metadata -> 'reviewer_description') IS NULL);

UPDATE public.lookup_values
SET metadata = jsonb_set(
                  jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('info'::text), TRUE),
                  '{reviewer_description}',
                  to_jsonb('Warehouse supervisor variance approval. Review variance summary + linked transfer and approve or reject.'::text),
                  TRUE
                ),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'task_type')
  AND value = 'warehouse_supervisor_approval'
  AND (metadata IS NULL
       OR (metadata -> 'tone') IS NULL
       OR (metadata -> 'reviewer_description') IS NULL);

UPDATE public.lookup_values
SET metadata = jsonb_set(
                  jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('info'::text), TRUE),
                  '{reviewer_description}',
                  to_jsonb('Out-of-sequence checkpoint scan correction. Review the scan trail and approve the override.'::text),
                  TRUE
                ),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'task_type')
  AND value = 'warehouse_scan_supervisor_approval'
  AND (metadata IS NULL
       OR (metadata -> 'tone') IS NULL
       OR (metadata -> 'reviewer_description') IS NULL);

UPDATE public.lookup_values
SET metadata = jsonb_set(
                  jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tone}', to_jsonb('info'::text), TRUE),
                  '{reviewer_description}',
                  to_jsonb('Driver-side route stop execution task. Reviewed in driver console, not the operator review queue.'::text),
                  TRUE
                ),
    updated_at = now()
WHERE lookup_definition_id = (SELECT id FROM public.lookup_definitions WHERE category = 'task_type')
  AND value = 'route_stop_execute'
  AND (metadata IS NULL
       OR (metadata -> 'tone') IS NULL
       OR (metadata -> 'reviewer_description') IS NULL);

-- ---------------------------------------------------------------------------
-- 4) task_type_catalog — default_actions jsonb projection
-- ---------------------------------------------------------------------------
-- Adds `default_actions` jsonb column to mirror
-- `task_type_catalog.assignment_defaults.allowed_actions`. Replaces the inline
-- TASK_TYPE_DEFAULT_ACTIONS Record literal in
-- modules/workflows/_review-queue/views.ts.

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_current JSONB;
  v_task_types JSONB;
  v_updated JSONB := '[]'::jsonb;
  v_item JSONB;
  v_key TEXT;
  v_defaults JSONB := jsonb_build_object(
    'manual_review', jsonb_build_array('approve', 'decline', 'escalate'),
    'dispatch_exception_review', jsonb_build_array('reschedule', 'reassign', 'rtb', 'resolve'),
    'route_stop_execute', jsonb_build_array(),
    'warehouse_supervisor_approval', jsonb_build_array('approve', 'reject'),
    'warehouse_scan_supervisor_approval', jsonb_build_array('approve', 'reject'),
    'shipment_amend_review', jsonb_build_array('approve', 'reject'),
    'tenant_signup_review', jsonb_build_array('approve', 'request_info', 'reject')
  );
BEGIN
  SELECT cached_value
    INTO v_current
    FROM public.settings
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
   LIMIT 1;

  IF v_current IS NULL OR jsonb_typeof(v_current) <> 'object' THEN
    RETURN;
  END IF;

  v_task_types := COALESCE(v_current -> 'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(v_task_types)
  LOOP
    v_key := lower(NULLIF(btrim(COALESCE(v_item ->> 'key', '')), ''));

    IF v_key IS NOT NULL AND v_defaults ? v_key THEN
      v_item := jsonb_set(v_item, '{default_actions}', v_defaults -> v_key, TRUE);
    END IF;

    v_updated := v_updated || jsonb_build_array(v_item);
  END LOOP;

  v_current := jsonb_set(v_current, '{task_types}', v_updated, TRUE);

  UPDATE public.settings_versions
     SET value = v_current
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND approved_at IS NOT NULL
     AND effective_until IS NULL
     AND value IS DISTINCT FROM v_current;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND cached_value IS DISTINCT FROM v_current;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 5) workflow_templates — template_key projection
-- ---------------------------------------------------------------------------
-- Adds `template_key` text column for canonical-key resolution. Replaces the
-- inline UUID literals (570002 / 570004) in finance/cod.tsx + bank-recon.tsx
-- with `resolve_workflow_template_id_v1(template_key)`.

ALTER TABLE public.workflow_templates
  ADD COLUMN IF NOT EXISTS template_key text;

COMMENT ON COLUMN public.workflow_templates.template_key IS
  'Canonical workflow template key (e.g. cod_driver_shift_settlement_v2, bank_deposit_reconciliation_v2). FE consumers resolve template_id through resolve_workflow_template_id_v1(template_key) instead of inlining UUID literals. Mirrors apps/console-v2/src/lib/seed-raw/workflows.js template_key field.';

CREATE UNIQUE INDEX IF NOT EXISTS workflow_templates_template_key_uniq
  ON public.workflow_templates (template_key)
  WHERE template_key IS NOT NULL;

-- Backfill canonical template_key by id for the 8 known canonical templates.
-- Each UPDATE is idempotent (only writes when template_key is NULL).
UPDATE public.workflow_templates SET template_key = 'exampleparcel_ksa_inbound_intake_v3', updated_at = now() WHERE id = '99990000-0000-0000-0000-000000570001'::uuid AND template_key IS NULL;
UPDATE public.workflow_templates SET template_key = 'cod_driver_shift_settlement_v2', updated_at = now() WHERE id = '99990000-0000-0000-0000-000000570002'::uuid AND template_key IS NULL;
UPDATE public.workflow_templates SET template_key = 'ndr_resolution_v2', updated_at = now() WHERE id = '99990000-0000-0000-0000-000000570003'::uuid AND template_key IS NULL;
UPDATE public.workflow_templates SET template_key = 'bank_deposit_reconciliation_v2', updated_at = now() WHERE id = '99990000-0000-0000-0000-000000570004'::uuid AND template_key IS NULL;
UPDATE public.workflow_templates SET template_key = 'route_plan_publish_v1', updated_at = now() WHERE id = '99990000-0000-0000-0000-000000570005'::uuid AND template_key IS NULL;
UPDATE public.workflow_templates SET template_key = 'warehouse_transfer_execute_v1', updated_at = now() WHERE id = '99990000-0000-0000-0000-000000570006'::uuid AND template_key IS NULL;
UPDATE public.workflow_templates SET template_key = 'shipment_amend_cancel_v1', updated_at = now() WHERE id = '99990000-0000-0000-0000-000000570007'::uuid AND template_key IS NULL;
UPDATE public.workflow_templates SET template_key = 'shipment_operator_create_v1', updated_at = now() WHERE id = '99990000-0000-0000-0000-000000570008'::uuid AND template_key IS NULL;

-- ---------------------------------------------------------------------------
-- 6) canonical_districts — centroid_lat / centroid_lng metadata
-- ---------------------------------------------------------------------------
-- Adds optional centroid columns for the 5 RUH neighborhoods rendered as
-- ambient labels on operate/tracking-map.tsx. Replaces the inline
-- DISTRICT_LABELS literal array. Production tenants extend the catalog by
-- inserting more rows + setting centroid_lat / centroid_lng.

ALTER TABLE public.canonical_districts
  ADD COLUMN IF NOT EXISTS centroid_lat double precision,
  ADD COLUMN IF NOT EXISTS centroid_lng double precision;

COMMENT ON COLUMN public.canonical_districts.centroid_lat IS
  'Optional canonical centroid latitude for ambient label rendering on operator tracking surfaces. NULL = district has no rendered label.';
COMMENT ON COLUMN public.canonical_districts.centroid_lng IS
  'Optional canonical centroid longitude for ambient label rendering on operator tracking surfaces. NULL = district has no rendered label.';

WITH global_riyadh AS (
  SELECT id
  FROM public.canonical_cities
  WHERE name_canonical = 'Riyadh'
    -- objectives:allow TENANT_LITERAL Justification: global canonical city seed lookup uses the zero UUID organization sentinel, not tenant/client/sender routing.
    AND organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY created_at NULLS LAST, id
  LIMIT 1
)
UPDATE public.canonical_districts cd
SET centroid_lat = COALESCE(cd.centroid_lat, 24.74),
    centroid_lng = COALESCE(cd.centroid_lng, 46.66),
    updated_at = now()
FROM global_riyadh gr
WHERE cd.city_id = gr.id
  AND (lower(cd.name_canonical) LIKE '%olaya%' OR lower(cd.name_canonical) LIKE '%ulayya%')
  AND (cd.centroid_lat IS NULL OR cd.centroid_lng IS NULL);

WITH global_riyadh AS (
  SELECT id
  FROM public.canonical_cities
  WHERE name_canonical = 'Riyadh'
    -- objectives:allow TENANT_LITERAL Justification: global canonical city seed lookup uses the zero UUID organization sentinel, not tenant/client/sender routing.
    AND organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY created_at NULLS LAST, id
  LIMIT 1
)
UPDATE public.canonical_districts cd
SET centroid_lat = COALESCE(cd.centroid_lat, 24.72),
    centroid_lng = COALESCE(cd.centroid_lng, 46.74),
    updated_at = now()
FROM global_riyadh gr
WHERE cd.city_id = gr.id
  AND (lower(cd.name_canonical) LIKE '%sulayman%' OR lower(cd.name_canonical) LIKE '%sulaimani%')
  AND (cd.centroid_lat IS NULL OR cd.centroid_lng IS NULL);

WITH global_riyadh AS (
  SELECT id
  FROM public.canonical_cities
  WHERE name_canonical = 'Riyadh'
    -- objectives:allow TENANT_LITERAL Justification: global canonical city seed lookup uses the zero UUID organization sentinel, not tenant/client/sender routing.
    AND organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY created_at NULLS LAST, id
  LIMIT 1
)
UPDATE public.canonical_districts cd
SET centroid_lat = COALESCE(cd.centroid_lat, 24.78),
    centroid_lng = COALESCE(cd.centroid_lng, 46.62),
    updated_at = now()
FROM global_riyadh gr
WHERE cd.city_id = gr.id
  AND lower(cd.name_canonical) LIKE '%malqa%'
  AND (cd.centroid_lat IS NULL OR cd.centroid_lng IS NULL);

WITH global_riyadh AS (
  SELECT id
  FROM public.canonical_cities
  WHERE name_canonical = 'Riyadh'
    -- objectives:allow TENANT_LITERAL Justification: global canonical city seed lookup uses the zero UUID organization sentinel, not tenant/client/sender routing.
    AND organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY created_at NULLS LAST, id
  LIMIT 1
)
UPDATE public.canonical_districts cd
SET centroid_lat = COALESCE(cd.centroid_lat, 24.76),
    centroid_lng = COALESCE(cd.centroid_lng, 46.69),
    updated_at = now()
FROM global_riyadh gr
WHERE cd.city_id = gr.id
  AND lower(cd.name_canonical) LIKE '%yasmin%'
  AND (cd.centroid_lat IS NULL OR cd.centroid_lng IS NULL);

WITH global_riyadh AS (
  SELECT id
  FROM public.canonical_cities
  WHERE name_canonical = 'Riyadh'
    -- objectives:allow TENANT_LITERAL Justification: global canonical city seed lookup uses the zero UUID organization sentinel, not tenant/client/sender routing.
    AND organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY created_at NULLS LAST, id
  LIMIT 1
)
UPDATE public.canonical_districts cd
SET centroid_lat = COALESCE(cd.centroid_lat, 24.69),
    centroid_lng = COALESCE(cd.centroid_lng, 46.69),
    updated_at = now()
FROM global_riyadh gr
WHERE cd.city_id = gr.id
  AND (lower(cd.name_canonical) LIKE '%hittin%' OR lower(cd.name_canonical) LIKE '%hiteen%')
  AND (cd.centroid_lat IS NULL OR cd.centroid_lng IS NULL);

-- ---------------------------------------------------------------------------
-- 7) route_plan_thresholds policy — wave_promise_window_seconds
-- ---------------------------------------------------------------------------
-- Adds the canonical SLA breach window (default 7200s = 2h) to the existing
-- route_plan_thresholds settings_versions row. Replaces the inline
-- `2 * 60 * 60 * 1000` literal in operate/route-plans.tsx isSlaBreach().

UPDATE public.settings_versions
SET value = jsonb_set(value, '{wave_promise_window_seconds}', to_jsonb(7200), TRUE)
WHERE category = 'route_plan_thresholds'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND approved_at IS NOT NULL
  AND effective_until IS NULL
  AND (value -> 'wave_promise_window_seconds') IS NULL;

-- ---------------------------------------------------------------------------
-- 8) Canonical resolver function: resolve_driver_hours_of_service_v1
-- ---------------------------------------------------------------------------
-- Provides the backend SSOT for the FE typed accessor. Returns the per-driver
-- hours-of-service projection (today segments + week totals). When the live
-- driver_hours_of_service projection table or RPC ships, the body returns
-- the canonical aggregate. Until then, the function returns NULL so the FE
-- typed facade can advance independently.

CREATE OR REPLACE FUNCTION public.resolve_driver_hours_of_service_v1(p_driver_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  -- Placeholder canonical resolver. Production swap fills in the projection
  -- aggregate from `driver_hours_of_service_projection` (deferred).
  SELECT NULL::jsonb;
$$;

COMMENT ON FUNCTION public.resolve_driver_hours_of_service_v1(uuid) IS
  'Canonical resolver for per-driver hours-of-service. FE consumes via api.resolve_driver_hours_of_service_v1(driver_id). Returns canonical aggregate { today: [{type, durationMinutes}], week_total: {driving, on_duty, off_duty, sleeper} } when projection lands; currently NULL placeholder so the typed FE facade can ship.';

-- ---------------------------------------------------------------------------
-- 9) Canonical resolver function: resolve_task_type_default_actions_v1
-- ---------------------------------------------------------------------------
-- FE consumes through api.resolve_task_type_default_actions_v1(task_type)
-- which returns the canonical default_actions array for the given task type.

CREATE OR REPLACE FUNCTION public.resolve_task_type_default_actions_v1(p_task_type text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH global_catalog AS (
    SELECT cached_value
      FROM public.settings
     WHERE category = 'task_type_catalog'
       AND scope_type = 'global'
       AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
     LIMIT 1
  ),
  task_items AS (
    SELECT item.value AS task_type_row
      FROM global_catalog
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cached_value -> 'task_types', '[]'::jsonb)) AS item(value)
  )
  SELECT COALESCE(
    (
      SELECT task_type_row -> 'default_actions'
        FROM task_items
       WHERE lower(COALESCE(task_type_row ->> 'key', '')) = lower(COALESCE(p_task_type, ''))
       LIMIT 1
    ),
    '[]'::jsonb
  );
$$;

COMMENT ON FUNCTION public.resolve_task_type_default_actions_v1(text) IS
  'Canonical resolver for task_type default action keys. Mirrors the FE typed accessor api.resolve_task_type_default_actions_v1. Replaces the inline TASK_TYPE_DEFAULT_ACTIONS Record literal in modules/workflows/_review-queue/views.ts.';

-- ---------------------------------------------------------------------------
-- 10) Canonical resolver function: resolve_workflow_template_id_v1
-- ---------------------------------------------------------------------------
-- Maps canonical template_key → workflow_templates.id. FE consumes through
-- api.resolve_workflow_template_id_v1(template_key) replacing inline UUID
-- literals in finance/cod.tsx + bank-recon.tsx.

CREATE OR REPLACE FUNCTION public.resolve_workflow_template_id_v1(p_template_key text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  SELECT id
  FROM public.workflow_templates
  WHERE template_key = p_template_key
    AND status = 'active'
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.resolve_workflow_template_id_v1(text) IS
  'Canonical resolver for workflow_templates.id by template_key. FE consumes through api.resolve_workflow_template_id_v1 replacing the inline cod/bank-recon UUID literals.';
