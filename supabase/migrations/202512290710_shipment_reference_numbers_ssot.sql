-- Plan: PLAN-202512-shipment-references-ssot / Step: S01
-- Migration: Shipment reference numbers (SSOT)
-- Purpose:
--   - Introduce a canonical, multi-row reference store per shipment.
--   - Support multiple logistics references per shipment without schema churn.
--   - Seed lookup taxonomy and default selection policy (settings ladder).
-- Date: 2025-12-29

BEGIN;

-------------------------------------------------------------------------------
-- 1) Lookup taxonomy: shipment_reference_type (row-driven)
-------------------------------------------------------------------------------
INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  created_at,
  updated_at
)
VALUES (
  'shipment_reference_type',
  'Reference type taxonomy for shipment_reference_numbers (client/carrier/logistics/etc).',
  'ops',
  NULL,
  TRUE,
  now(),
  now()
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    updated_at = now();

WITH def AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'shipment_reference_type'
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
  metadata,
  created_at,
  updated_at
)
SELECT
  def.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  '{}'::jsonb,
  now(),
  now()
FROM def
JOIN (
  VALUES
    ('client_reference_number', 'Client Reference', 'Client business reference number (unique per client).', 10),
    ('carrier_reference_number', 'Carrier Reference', '3PL/carrier reference number.', 20),
    ('logistics_reference_number', 'Logistics Reference', 'External logistics reference number (0..N per shipment).', 30),
    ('masarx_reference_number', 'MasarX Reference', 'MasarX internal reference number (if distinct from tracking_number).', 40),
    ('legacy_lmd_system_reference', 'Legacy LMD Reference', 'Legacy bridge reference (migration-only).', 90)
) AS v(value, label, description, sort_order)
  ON TRUE
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    updated_at = now();

-------------------------------------------------------------------------------
-- 2) Canonical table: shipment_reference_numbers
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shipment_reference_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  shipment_id UUID NOT NULL,

  reference_type TEXT NOT NULL, -- lookup category: shipment_reference_type
  reference_value TEXT NOT NULL,
  reference_value_upper TEXT GENERATED ALWAYS AS (upper(NULLIF(btrim(reference_value), ''))) STORED,

  source_type TEXT, -- optional: client|provider|system|ops
  source_id UUID,   -- optional: provider_id/webhook_source_id/etc
  metadata JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shipment_reference_numbers_reference_type_ck CHECK (btrim(reference_type) <> ''),
  CONSTRAINT shipment_reference_numbers_reference_value_ck CHECK (btrim(reference_value) <> ''),
  CONSTRAINT shipment_reference_numbers_ref_upper_ck CHECK (reference_value_upper IS NOT NULL),
  CONSTRAINT shipment_reference_numbers_shipment_fk
    FOREIGN KEY (shipment_id, client_id) REFERENCES public.shipments(id, client_id) ON DELETE CASCADE
);

-- Prevent duplicate rows for the same shipment/type/value.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shipment_reference_numbers_shipment_type_value
  ON public.shipment_reference_numbers (client_id, shipment_id, reference_type, reference_value_upper)
  WHERE reference_value_upper IS NOT NULL;

-- Fast lookups (find shipment by reference).
CREATE INDEX IF NOT EXISTS idx_shipment_reference_numbers_lookup
  ON public.shipment_reference_numbers (client_id, reference_type, reference_value_upper);

CREATE INDEX IF NOT EXISTS idx_shipment_reference_numbers_org_lookup
  ON public.shipment_reference_numbers (organization_id, reference_value_upper);

COMMENT ON TABLE public.shipment_reference_numbers
  IS 'Canonical shipment reference numbers (multi-row) supporting client/3PL/logistics refs; row-driven types via lookup_values.';
COMMENT ON COLUMN public.shipment_reference_numbers.reference_type
  IS 'Lookup category shipment_reference_type (client_reference_number, carrier_reference_number, logistics_reference_number, etc).';

-------------------------------------------------------------------------------
-- 3) RLS (user-facing table: enforce org isolation via shipments join)
-------------------------------------------------------------------------------
ALTER TABLE public.shipment_reference_numbers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shipment_reference_numbers FROM PUBLIC;
REVOKE ALL ON TABLE public.shipment_reference_numbers FROM anon;
REVOKE ALL ON TABLE public.shipment_reference_numbers FROM authenticated;

DROP POLICY IF EXISTS shipment_reference_numbers_service_policy ON public.shipment_reference_numbers;
CREATE POLICY shipment_reference_numbers_service_policy
  ON public.shipment_reference_numbers
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS shipment_reference_numbers_tenant_select ON public.shipment_reference_numbers;
CREATE POLICY shipment_reference_numbers_tenant_select
  ON public.shipment_reference_numbers
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.shipments s
      WHERE s.id = shipment_reference_numbers.shipment_id
        AND s.client_id = shipment_reference_numbers.client_id
        AND s.organization_id = current_user_org_id()
    )
  );

-------------------------------------------------------------------------------
-- 4) Backfill from existing shipment columns (best-effort, idempotent)
-------------------------------------------------------------------------------
INSERT INTO public.shipment_reference_numbers (
  organization_id,
  client_id,
  shipment_id,
  reference_type,
  reference_value,
  source_type,
  metadata,
  created_at,
  updated_at
)
SELECT
  s.organization_id,
  s.client_id,
  s.id,
  'client_reference_number',
  s.client_reference_number,
  'system',
  jsonb_build_object('backfill', TRUE, 'source', 'shipments.client_reference_number'),
  now(),
  now()
FROM public.shipments s
WHERE upper(NULLIF(btrim(s.client_reference_number), '')) IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.shipment_reference_numbers (
  organization_id,
  client_id,
  shipment_id,
  reference_type,
  reference_value,
  source_type,
  metadata,
  created_at,
  updated_at
)
SELECT
  s.organization_id,
  s.client_id,
  s.id,
  'carrier_reference_number',
  s.carrier_reference_number,
  'system',
  jsonb_build_object('backfill', TRUE, 'source', 'shipments.carrier_reference_number'),
  now(),
  now()
FROM public.shipments s
WHERE upper(NULLIF(btrim(s.carrier_reference_number), '')) IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.shipment_reference_numbers (
  organization_id,
  client_id,
  shipment_id,
  reference_type,
  reference_value,
  source_type,
  metadata,
  created_at,
  updated_at
)
SELECT
  s.organization_id,
  s.client_id,
  s.id,
  'legacy_lmd_system_reference',
  s.lmd_system_reference,
  'system',
  jsonb_build_object('backfill', TRUE, 'source', 'shipments.lmd_system_reference'),
  now(),
  now()
FROM public.shipments s
WHERE upper(NULLIF(btrim(s.lmd_system_reference), '')) IS NOT NULL
ON CONFLICT DO NOTHING;

-------------------------------------------------------------------------------
-- 5) Settings: shipment_reference_policy (default selection order)
-------------------------------------------------------------------------------
INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active,
  created_at
)
VALUES (
  'shipment_reference_policy',
  1,
  $${
    "type": "object",
    "additionalProperties": false,
    "required": ["version", "label"],
    "properties": {
      "version": { "type": "integer", "const": 1 },
      "label": {
        "type": "object",
        "additionalProperties": false,
        "required": ["reference_order"],
        "properties": {
          "reference_order": {
            "type": "array",
            "items": { "type": "string" },
            "minItems": 1
          }
        }
      }
    }
  }$$::jsonb,
  'Policy for selecting display reference numbers for shipments (ladder-resolved).',
  $$[
    {
      "version": 1,
      "label": { "reference_order": ["client_reference_number", "carrier_reference_number", "tracking_number"] }
    }
  ]$$::jsonb,
  TRUE,
  now()
)
ON CONFLICT (category, version) DO NOTHING;

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'label', jsonb_build_object(
      'reference_order', jsonb_build_array(
        'client_reference_number',
        'carrier_reference_number',
        'tracking_number'
      )
    )
  ) AS value
), upsert_version AS (
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
    effective_from,
    effective_until
  )
  SELECT
    COALESCE(
      (
        SELECT id
        FROM public.settings_versions
        WHERE category = 'shipment_reference_policy'
          AND scope_type = 'global'
          AND scope_id IS NULL
        ORDER BY approved_at DESC
        LIMIT 1
      ),
      public.uuid_from_hash('shipment_reference_policy:global')
    ) AS id,
    'shipment_reference_policy',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    payload.value,
    1,
    'Seed default shipment reference selection policy (label reference order).',
    now(),
    now(),
    NULL
  FROM payload
  ON CONFLICT (id, scope_hash) DO UPDATE
  SET value = EXCLUDED.value,
      schema_version = EXCLUDED.schema_version,
      change_reason = EXCLUDED.change_reason,
      approved_at = EXCLUDED.approved_at,
      effective_from = EXCLUDED.effective_from,
      effective_until = EXCLUDED.effective_until
  RETURNING id, value
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
  public.uuid_from_hash('shipment_reference_policy:global:settings'),
  'shipment_reference_policy',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  upsert_version.id,
  upsert_version.value,
  now()
FROM upsert_version
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

COMMIT;

