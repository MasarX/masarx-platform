-- Migration: Lock down EXECUTE grants for batch label renderer RPCs
-- Purpose: Ensure anon/authenticated cannot invoke internal batch helpers.

BEGIN;

SET search_path TO public, extensions, pg_temp;

REVOKE ALL ON FUNCTION public.compose_label_payloads(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compose_label_payloads(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.compose_label_payloads(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.compose_label_payloads(uuid[]) TO service_role, edge_label_renderer_role;

REVOKE ALL ON FUNCTION public.complete_label_jobs(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_label_jobs(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.complete_label_jobs(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_label_jobs(jsonb) TO service_role, edge_label_renderer_role;

COMMIT;

