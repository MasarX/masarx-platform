-- Migration: Label barcode warnings views (ops visibility)
-- Purpose:
--  - Provide canonical, queryable views over label_jobs.renderer_metadata.barcode
--    so operations can quickly find labels/jobs with barcode warnings.
--  - No raw barcode values are exposed (only lengths, quality, engines, and policy outcomes).

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE VIEW public.label_job_barcode_summary_v AS
SELECT
  lj.organization_id,
  lj.client_id,
  lj.id AS job_id,
  lj.shipment_id,
  lj.shipment_box_id,
  lj.label_type,
  lj.status,
  lj.created_at,
  lj.completed_at,
  lj.output_file_url,
  lj.output_file_size_bytes,
  lj.template_id,
  lj.template_version,
  NULLIF(lj.renderer_metadata #>> '{template,key}', '') AS template_key,
  NULLIF(lj.renderer_metadata #>> '{template,version}', '') AS template_key_version,
  NULLIF(lj.renderer_metadata #>> '{barcode,engine}', '') AS barcode_engine,
  COALESCE(NULLIF(lj.renderer_metadata #>> '{barcode,policy,gate_mode}', ''), 'unknown') AS barcode_gate_mode,
  COALESCE((lj.renderer_metadata #>> '{barcode,policy,would_fail}')::boolean, FALSE) AS barcode_would_fail,
  COALESCE((lj.renderer_metadata #>> '{barcode,policy,should_warn}')::boolean, FALSE) AS barcode_should_warn,
  jsonb_array_length(COALESCE(lj.renderer_metadata #> '{barcode,policy,violations}', '[]'::jsonb)) AS barcode_violations_count,
  COALESCE(lj.renderer_metadata #> '{barcode,policy,violations}', '[]'::jsonb) AS barcode_violations,
  COALESCE(lj.renderer_metadata #> '{barcode,blocks}', '[]'::jsonb) AS barcode_blocks,
  NULLIF(lj.renderer_metadata #>> '{timings,compose_ms}', '')::numeric AS compose_ms,
  NULLIF(lj.renderer_metadata #>> '{timings,render_ms}', '')::numeric AS render_ms,
  NULLIF(lj.renderer_metadata #>> '{timings,upload_ms}', '')::numeric AS upload_ms,
  NULLIF(lj.renderer_metadata #>> '{timings,total_ms}', '')::numeric AS total_ms
FROM public.label_jobs lj
WHERE lj.renderer_metadata ? 'barcode';

COMMENT ON VIEW public.label_job_barcode_summary_v IS
  'Summary of barcode engines/quality/policy outcomes per label_job (from renderer_metadata.barcode).';

CREATE OR REPLACE VIEW public.label_job_barcode_blocks_v AS
SELECT
  lj.organization_id,
  lj.client_id,
  lj.id AS job_id,
  lj.label_type,
  lj.status,
  lj.created_at,
  lj.completed_at,
  NULLIF(b ->> 'block_type', '') AS block_type,
  NULLIF(b ->> 'value_path', '') AS value_path,
  NULLIF(b ->> 'asset_ref', '') AS asset_ref,
  NULLIF(b ->> 'align', '') AS align,
  NULLIF(b ->> 'engine', '') AS engine,
  NULLIF(b ->> 'quality', '') AS quality,
  NULLIF(b ->> 'dpi', '')::int AS dpi,
  NULLIF(b ->> 'input_length', '')::int AS input_length,
  NULLIF(b ->> 'module_width_dots', '')::int AS module_width_dots,
  NULLIF(b ->> 'quiet_zone_modules', '')::int AS quiet_zone_modules,
  NULLIF(b ->> 'total_modules', '')::int AS total_modules,
  COALESCE(NULLIF(b ->> 'fractional_module_width', '')::boolean, FALSE) AS fractional_module_width,
  NULLIF(b ->> 'fallback_reason', '') AS fallback_reason,
  NULLIF(b ->> 'vector_error_code', '') AS vector_error_code
FROM public.label_jobs lj
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(lj.renderer_metadata #> '{barcode,blocks}', '[]'::jsonb)) b
WHERE lj.renderer_metadata ? 'barcode';

COMMENT ON VIEW public.label_job_barcode_blocks_v IS
  'Flattened barcode blocks per label_job (one row per barcode block) from renderer_metadata.barcode.blocks.';

COMMIT;

