-- Console V2 first-tenant readiness: zone KPI status metadata.
--
-- Network Zones uses lookup_values.metadata to decide which status values
-- count as active or suspended. Earlier seeds carried tone only in live DB,
-- which made real active zones show as "0 active" in Console V2.

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH desired(value, flags) AS (
  VALUES
    ('active', jsonb_build_object(
      'is_active_zone_status', true,
      'is_suspended_zone_status', false
    )),
    ('draft', jsonb_build_object(
      'is_active_zone_status', false,
      'is_suspended_zone_status', false
    )),
    ('paused', jsonb_build_object(
      'is_active_zone_status', false,
      'is_suspended_zone_status', true
    )),
    ('suspended', jsonb_build_object(
      'is_active_zone_status', false,
      'is_suspended_zone_status', true
    )),
    ('archived', jsonb_build_object(
      'is_active_zone_status', false,
      'is_suspended_zone_status', false
    )),
    ('retired', jsonb_build_object(
      'is_active_zone_status', false,
      'is_suspended_zone_status', false
    ))
)
UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || desired.flags,
    updated_at = now()
FROM public.lookup_definitions ld, desired
WHERE ld.id = lv.lookup_definition_id
  AND ld.category = 'zone_status'
  AND lv.value = desired.value;

COMMENT ON TABLE public.lookup_values IS
  'Lookup values. Console V2 zone_status rows must include is_active_zone_status and is_suspended_zone_status metadata flags for row-driven Network Zones KPIs.';

COMMIT;
