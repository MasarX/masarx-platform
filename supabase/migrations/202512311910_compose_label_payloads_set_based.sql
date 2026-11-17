-- Migration: Optimize compose_label_payloads (set-based, no per-row loop)
-- Purpose: Reduce synchronous print latency by composing payloads in one query instead of N function calls.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.compose_label_payloads(p_job_ids uuid[])
RETURNS TABLE (job_id uuid, composed jsonb, compose_ms numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH jobs AS (
    SELECT lj.*
    FROM public.label_jobs lj
    WHERE lj.id = ANY (p_job_ids)
  ),
  payload_by_job AS (
    SELECT
      j.id AS job_id,
      COALESCE(to_jsonb(p), '{}'::jsonb) AS payload
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT p.*
      FROM public.shipment_label_payload_v p
      WHERE p.shipment_id = j.shipment_id
        AND (
          j.shipment_box_id IS NULL
          OR p.shipment_box_id = j.shipment_box_id
        )
      ORDER BY p.box_number NULLS FIRST
      LIMIT 1
    ) p ON TRUE
  )
  SELECT
    j.id AS job_id,
    jsonb_build_object(
      'job',
      jsonb_build_object(
        'id', j.id,
        'organization_id', j.organization_id,
        'client_id', j.client_id,
        'shipment_id', j.shipment_id,
        'shipment_box_id', j.shipment_box_id,
        'label_type', j.label_type,
        'attempts', j.attempts,
        'max_attempts', j.max_attempts,
        'template', j.template_snapshot,
        'renderer_hint', j.renderer_hint,
        'retry_state', j.retry_state
      ),
      'payload',
      payload_by_job.payload
    ) AS composed,
    0::numeric AS compose_ms
  FROM jobs j
  JOIN payload_by_job ON payload_by_job.job_id = j.id;
$function$;

COMMIT;

