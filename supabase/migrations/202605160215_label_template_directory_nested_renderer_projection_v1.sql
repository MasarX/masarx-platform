-- Migration: Surface nested renderer metadata in the label template directory.
-- Purpose:
--   Current waybill templates store page/barcode metadata under
--   renderer_config.page and renderer_config.barcode. Keep the existing
--   view shape, but derive dimensions, dpi, and barcode_format from those
--   nested backend fields when the older top-level aliases are absent.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605160215_label_template_directory_nested_renderer_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_label_template_directory
  WITH (security_invoker = true)
  AS
WITH job_agg AS (
  SELECT
    lj.template_id,
    COUNT(*) AS render_count,
    COUNT(*) FILTER (
      WHERE lj.scheduled_at >= now() - INTERVAL '24 hours'
    ) AS render_count_24h,
    MAX(lj.scheduled_at) AS last_used_at,
    COUNT(*) FILTER (WHERE lj.status = 'succeeded') AS completed_count,
    COUNT(*) FILTER (WHERE lj.status = 'failed') AS failed_count
  FROM public.label_jobs lj
  GROUP BY lj.template_id
),
version_agg AS (
  SELECT
    lts.organization_id,
    lts.template_key,
    COUNT(*) AS version_count,
    MAX(lts.version) AS max_version
  FROM public.label_template_specs lts
  GROUP BY lts.organization_id, lts.template_key
)
SELECT
  lts.id,
  lts.organization_id,
  lts.template_key,
  lts.version,
  lts.template_scope_type,
  lts.template_scope_id,
  lts.renderer_config,
  lts.asset_refs,
  lts.created_by,
  lts.created_at,
  COALESCE(
    NULLIF(lts.renderer_config->>'dimensions', ''),
    CASE
      WHEN lts.renderer_config ? 'page' THEN concat_ws(
        ' x ',
        NULLIF(COALESCE(lts.renderer_config#>>'{page,width_mm}', lts.renderer_config#>>'{page,width_inch}'), ''),
        NULLIF(COALESCE(lts.renderer_config#>>'{page,height_mm}', lts.renderer_config#>>'{page,height_inch}'), '')
      )
      ELSE NULL
    END
  ) AS dimensions,
  COALESCE(
    NULLIF(lts.renderer_config->>'dpi', '')::INT,
    NULLIF(lts.renderer_config#>>'{page,dpi}', '')::INT
  ) AS dpi,
  COALESCE(
    NULLIF(lts.renderer_config->>'barcode_format', ''),
    NULLIF(lts.renderer_config#>>'{barcode,type}', '')
  ) AS barcode_format,
  NULLIF(lts.renderer_config->>'active_version_id', '') AS active_version_id,
  o.name AS tenant_label,
  o.slug AS tenant_slug,
  u.full_name AS created_by_label,
  u.email AS created_by_email,
  COALESCE(job_agg.render_count, 0)::INT AS render_count,
  COALESCE(job_agg.render_count_24h, 0)::INT AS render_count_24h,
  job_agg.last_used_at AS last_used_at,
  COALESCE(job_agg.completed_count, 0)::INT AS completed_count,
  COALESCE(job_agg.failed_count, 0)::INT AS failed_count,
  COALESCE(version_agg.version_count, 1)::INT AS version_count,
  (lts.version = COALESCE(version_agg.max_version, lts.version)) AS is_active_version,
  COALESCE(jsonb_array_length(lts.asset_refs), 0)::INT AS asset_count
FROM public.label_template_specs lts
LEFT JOIN public.organizations o ON o.id = lts.organization_id
LEFT JOIN public.users u ON u.id = lts.created_by
LEFT JOIN job_agg ON job_agg.template_id = lts.id
LEFT JOIN version_agg
  ON version_agg.organization_id = lts.organization_id
 AND version_agg.template_key = lts.template_key;

COMMENT ON VIEW public.v_label_template_directory IS
  'FE-friendly projection of label_template_specs with renderer_config projections. Dimensions/dpi/barcode_format are derived from top-level renderer aliases or nested renderer_config.page/barcode fields; lifecycle counters come from label_jobs. Read-only; SSOT remains label_template_specs; mutations go through label designer RPCs.';

REVOKE ALL ON public.v_label_template_directory FROM PUBLIC;
REVOKE ALL ON public.v_label_template_directory FROM anon;
GRANT SELECT ON public.v_label_template_directory TO authenticated;
GRANT SELECT ON public.v_label_template_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605160215_label_template_directory_nested_renderer_projection_v1'));
COMMIT;
