-- Migration: Mobile V2 incident-type registry policy
-- Date: 2026-05-17
-- Spec: FieldOps V2 production-readiness — closes engineering audit
--       B1 / I2. The Mobile V2 incident report sheet
--       (`apps/fieldops/src/mobile-v2-sheet-incident.tsx`) drove its
--       incident-type registry off a PREVIEW/DEV fixture
--       (`fixtures/mobile-v2-incident-fixtures.ts`) and the
--       `submit_fieldops_incident_v1` write RPC had zero callers.
--
--       This migration registers the `mobile_incident_policy` settings
--       category so the registry resolves through the standard ladder
--       (Global < Tenant < Client < Sender < Source/Resource, with hub
--       overrides via `public.branches`). The frontend hook
--       `useFieldopsIncidentTypesRpc` reads it via
--       `resolve_settings_row_from_policy_context_v1` (api.* mirror) and
--       parses it with `parseMobileV2IncidentTypeList`; the FE fixture
--       becomes the preview/offline fallback only.
--
-- AGENTS.md compliance posture:
--   - Zero hardcoding: the incident-type taxonomy (severity + required
--     artefacts) is row-driven config, not an FE constant.
--   - Override ladder: registered with the canonical scope set; hub
--     overrides via `public.branches` like the sibling mobile_* policy
--     categories.
--   - RLS: no tables created; `settings_versions` / `settings` already
--     carry their own RLS. The category registry + schema registry are
--     service-managed reference tables.
--   - Idempotent: ON CONFLICT upserts; advisory-locked migration;
--     append-only — no edits to historical migration files.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605170000_mobile_incident_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Category registry
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES
  (
    'mobile_incident_policy',
    'Mobile V2 driver incident-report type registry (collision / medical / theft / damage / complaint / breakdown) with severity and required-artefact taxonomy resolved via ladder; hub overrides via public.branches.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Schema registry — JSON Schema for the category
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'mobile_incident_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Incident Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'types'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'types', jsonb_build_object(
          'type', 'array',
          'minItems', 1,
          'items', jsonb_build_object(
            'type', 'object',
            'required', jsonb_build_array('id', 'label', 'icon', 'severity', 'needs'),
            'properties', jsonb_build_object(
              'id', jsonb_build_object('type', 'string'),
              'label', jsonb_build_object('type', 'string'),
              'icon', jsonb_build_object('type', 'string'),
              'severity', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('high', 'med', 'low')),
              'needs', jsonb_build_object(
                'type', 'array',
                'items', jsonb_build_object(
                  'type', 'string',
                  'enum', jsonb_build_array('photo', 'geo', 'statement', 'call_112', 'call_999')
                )
              )
            )
          )
        )
      )
    ),
    'Driver incident-report type registry: severity-tiered types with required-artefact (photo / geo / statement / call_112 / call_999) gating.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'types', jsonb_build_array(
        jsonb_build_object('id', 'collision', 'label', 'Vehicle collision', 'icon', 'alert', 'severity', 'high', 'needs', jsonb_build_array('photo', 'geo', 'statement')),
        jsonb_build_object('id', 'medical', 'label', 'Medical emergency', 'icon', 'cross', 'severity', 'high', 'needs', jsonb_build_array('call_112')),
        jsonb_build_object('id', 'theft', 'label', 'Theft / robbery', 'icon', 'shield', 'severity', 'high', 'needs', jsonb_build_array('call_999', 'statement')),
        jsonb_build_object('id', 'damage', 'label', 'Vehicle damage (no incident)', 'icon', 'truck', 'severity', 'med', 'needs', jsonb_build_array('photo')),
        jsonb_build_object('id', 'complaint', 'label', 'Customer complaint', 'icon', 'flag', 'severity', 'low', 'needs', jsonb_build_array('statement')),
        jsonb_build_object('id', 'breakdown', 'label', 'Vehicle breakdown', 'icon', 'wrench', 'severity', 'med', 'needs', jsonb_build_array('geo'))
      )
    )),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active;

-------------------------------------------------------------------------------
-- 3) Global default seed (settings_versions + settings cache)
--    The default registry mirrors the design-canvas ScrIncident artboard
--    so the live shell renders the same six incident types the FE
--    fixture rehearsed; tenants override via the ladder.
-------------------------------------------------------------------------------

WITH seeds AS (
  SELECT * FROM (VALUES
    ('mobile_incident_policy'::text,
     'b1f0a3d2-7c64-4e8a-9d11-2f4a6b8c0e51'::uuid,
     'c2e1b4d3-8d75-4f9b-ae22-3a5b7c9d1f62'::uuid,
     jsonb_build_object(
       'version', 1,
       'types', jsonb_build_array(
         jsonb_build_object('id', 'collision', 'label', 'Vehicle collision', 'icon', 'alert', 'severity', 'high', 'needs', jsonb_build_array('photo', 'geo', 'statement')),
         jsonb_build_object('id', 'medical', 'label', 'Medical emergency', 'icon', 'cross', 'severity', 'high', 'needs', jsonb_build_array('call_112')),
         jsonb_build_object('id', 'theft', 'label', 'Theft / robbery', 'icon', 'shield', 'severity', 'high', 'needs', jsonb_build_array('call_999', 'statement')),
         jsonb_build_object('id', 'damage', 'label', 'Vehicle damage (no incident)', 'icon', 'truck', 'severity', 'med', 'needs', jsonb_build_array('photo')),
         jsonb_build_object('id', 'complaint', 'label', 'Customer complaint', 'icon', 'flag', 'severity', 'low', 'needs', jsonb_build_array('statement')),
         jsonb_build_object('id', 'breakdown', 'label', 'Vehicle breakdown', 'icon', 'wrench', 'severity', 'med', 'needs', jsonb_build_array('geo'))
       )
     ))
  ) AS t(category, settings_version_id, settings_id, value)
),
upserted_versions AS (
  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    s.settings_version_id,
    s.category,
    'global'::text,
    NULL::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    s.value,
    1,
    'Mobile V2 incident policy — initial global default',
    now(),
    now()
  FROM seeds s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = s.category
      AND sv.scope_type = 'global'
      AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.effective_until IS NULL
      AND sv.approved_at IS NOT NULL
  )
  RETURNING id, category, value
),
all_versions AS (
  SELECT id, category, value FROM upserted_versions
  UNION ALL
  SELECT sv.id, sv.category, sv.value
  FROM public.settings_versions sv
  JOIN seeds s ON s.category = sv.category
  WHERE sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM upserted_versions uv WHERE uv.category = sv.category)
)
INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  s.settings_id,
  av.category,
  'global'::text,
  NULL::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  av.id,
  av.value,
  now()
FROM all_versions av
JOIN seeds s ON s.category = av.category
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

SELECT pg_advisory_unlock(hashtext('202605170000_mobile_incident_policy_v1'));
COMMIT;
