-- Console V2 zone performance metrics projection and registry entry.
-- SSOT remains zones, shipments, and baskets. This view is read-only and
-- exists so Console V2 reads performance KPIs through ui_list_resource_v1
-- instead of seed-only frontend helpers.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041100_console_v2_zone_performance_metrics_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_zone_performance_metrics;

CREATE VIEW public.v_zone_performance_metrics
WITH (security_invoker = true)
AS
WITH delivered_statuses AS (
  SELECT lv.value
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'shipment_status'
     AND lv.status = 'active'
     AND lv.value = 'delivered'
),
shipment_rollup AS (
  SELECT
    z.id AS zone_id,
    COUNT(s.id) FILTER (
      WHERE s.created_at >= date_trunc('day', now())
    )::INT AS shipments_today,
    COUNT(s.id) FILTER (
      WHERE s.created_at >= date_trunc('day', now()) - INTERVAL '6 days'
    )::INT AS shipments_week,
    COUNT(s.id) FILTER (
      WHERE s.status IN (SELECT value FROM delivered_statuses)
    )::INT AS delivered_count,
    COUNT(s.id) FILTER (
      WHERE s.status IN (SELECT value FROM delivered_statuses)
        AND (
          s.promised_delivery_date IS NULL
          OR s.status_updated_at::DATE <= s.promised_delivery_date
        )
    )::INT AS on_time_delivered_count
  FROM public.zones z
  LEFT JOIN public.shipments s ON s.zone_id = z.id
  GROUP BY z.id
),
capacity_rollup AS (
  SELECT
    b.zone_id,
    CASE
      WHEN COALESCE(SUM(NULLIF(b.capacity_count, 0)), 0) = 0 THEN 0::NUMERIC
      ELSE LEAST(
        1::NUMERIC,
        COALESCE(SUM(b.current_count), 0)::NUMERIC / SUM(NULLIF(b.capacity_count, 0))::NUMERIC
      )
    END AS capacity_saturation_pct
  FROM public.baskets b
  WHERE b.zone_id IS NOT NULL
  GROUP BY b.zone_id
)
SELECT
  z.id AS zone_id,
  z.id AS id,
  z.organization_id,
  COALESCE(sr.shipments_today, 0)::INT AS shipments_today,
  COALESCE(sr.shipments_week, 0)::INT AS shipments_week,
  CASE
    WHEN COALESCE(sr.delivered_count, 0) = 0 THEN NULL
    ELSE ROUND((sr.on_time_delivered_count::NUMERIC / sr.delivered_count::NUMERIC), 4)
  END AS on_time_pct,
  COALESCE(cr.capacity_saturation_pct, 0)::NUMERIC AS capacity_saturation_pct,
  ARRAY(
    SELECT COALESCE(COUNT(s.id), 0)::INT
      FROM generate_series(7, 0, -1) AS g(hour_offset)
      LEFT JOIN public.shipments s
        ON s.zone_id = z.id
       AND s.created_at >= date_trunc('hour', now()) - (g.hour_offset || ' hours')::INTERVAL
       AND s.created_at <  date_trunc('hour', now()) - ((g.hour_offset - 1) || ' hours')::INTERVAL
     GROUP BY g.hour_offset
     ORDER BY g.hour_offset DESC
  ) AS spark_today,
  ARRAY(
    SELECT COALESCE(COUNT(s.id), 0)::INT
      FROM generate_series(7, 0, -1) AS g(day_offset)
      LEFT JOIN public.shipments s
        ON s.zone_id = z.id
       AND s.created_at::DATE = (current_date - g.day_offset::INT)
     GROUP BY g.day_offset
     ORDER BY g.day_offset DESC
  ) AS spark_week,
  now() AS updated_at
FROM public.zones z
LEFT JOIN shipment_rollup sr ON sr.zone_id = z.id
LEFT JOIN capacity_rollup cr ON cr.zone_id = z.id;

COMMENT ON VIEW public.v_zone_performance_metrics IS
  'Console V2 read-only projection for zone performance KPIs. Sources: zones, shipments, baskets. Read through ui_list_resource_v1 as zone_performance_metrics.';

REVOKE ALL ON public.v_zone_performance_metrics FROM PUBLIC;
REVOKE ALL ON public.v_zone_performance_metrics FROM anon;
GRANT SELECT ON public.v_zone_performance_metrics TO authenticated, service_role;

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_filtered JSONB;
  v_resource JSONB := '{
    "key": "zone_performance_metrics",
    "relation": "public.v_zone_performance_metrics",
    "id_column": "zone_id",
    "capability_read": "zones.read",
    "scope_columns": {"tenant": "organization_id"},
    "default_sort": {"column": "updated_at", "direction": "desc"},
    "filters": [
      {"key": "zone_id", "column": "zone_id", "op": "eq"}
    ]
  }'::jsonb;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);

  SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
    INTO v_filtered
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
   WHERE value->>'key' <> v_resource->>'key';

  v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

  UPDATE public.settings_versions
     SET value = v_current,
         updated_at = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605041100_console_v2_zone_performance_metrics_v1'));

COMMIT;
