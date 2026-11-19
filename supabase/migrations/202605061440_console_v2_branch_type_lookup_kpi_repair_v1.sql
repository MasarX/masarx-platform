-- Repair Console V2 branch-type lookup metadata used by the tenant setup
-- operator surface. The branch screen is row-driven by branch_type lookup
-- metadata for KPI buckets and labels, so live lookup rows must match the
-- bundled Console V2 seed contract.

BEGIN;

WITH branch_type_definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'branch_type'
  LIMIT 1
),
upserted AS (
  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    sort_order,
    is_default,
    status,
    metadata,
    published_at,
    updated_at
  )
  SELECT
    branch_type_definition.id,
    row.value,
    row.label,
    row.sort_order,
    row.is_default,
    'active',
    row.metadata::jsonb,
    COALESCE(existing.published_at, now()),
    now()
  FROM branch_type_definition
  CROSS JOIN (VALUES
    ('hub',           'Hub',       10, FALSE, '{"tone":"info","kpi_card_key":"hubs","kpi_card_tone":"info"}'),
    ('depot',         'Depot',     20, FALSE, '{"tone":"neutral","kpi_card_key":"depots","kpi_card_tone":"neutral"}'),
    ('warehouse',     'Warehouse', 30, FALSE, '{"tone":"neutral","kpi_card_key":"branches","kpi_card_tone":"neutral"}'),
    ('branch',        'Branch',    40, FALSE, '{"tone":"neutral","kpi_card_key":"branches","kpi_card_tone":"neutral"}'),
    ('satellite',     'Satellite', 50, FALSE, '{"tone":"good","kpi_card_key":"branches","kpi_card_tone":"good"}'),
    ('counter',       'Counter',   60, FALSE, '{"tone":"neutral","kpi_card_key":"dropoffs","kpi_card_tone":"neutral"}'),
    ('dropoff_point', 'Drop-off',  70, FALSE, '{"tone":"good","kpi_card_key":"dropoffs","kpi_card_tone":"good"}')
  ) AS row(value, label, sort_order, is_default, metadata)
  LEFT JOIN public.lookup_values existing
    ON existing.lookup_definition_id = branch_type_definition.id
   AND existing.value = row.value
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      sort_order = EXCLUDED.sort_order,
      is_default = EXCLUDED.is_default,
      status = 'active',
      metadata = EXCLUDED.metadata,
      retired_at = NULL,
      archived_at = NULL,
      published_at = COALESCE(public.lookup_values.published_at, EXCLUDED.published_at),
      updated_at = now()
  RETURNING 1
)
UPDATE public.lookup_values legacy
SET status = 'archived',
    retired_at = COALESCE(legacy.retired_at, now()),
    archived_at = COALESCE(legacy.archived_at, now()),
    metadata = jsonb_strip_nulls(
      COALESCE(legacy.metadata, '{}'::jsonb) ||
      jsonb_build_object(
        'replaced_by', 'dropoff_point',
        'retirement_reason', 'Console V2 branch type canonicalization'
      )
    ),
    updated_at = now()
FROM public.lookup_definitions definition
WHERE definition.id = legacy.lookup_definition_id
  AND definition.category = 'branch_type'
  AND legacy.value = 'drop_off';

COMMIT;
