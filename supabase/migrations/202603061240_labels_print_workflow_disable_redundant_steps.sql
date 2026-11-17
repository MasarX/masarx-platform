-- Migration: Disable redundant labels_print_workflow_v1 hops
-- Purpose:
--  - Remove no-op workflow latency from generate_barcodes and render_labels_pdf.
--  - Preserve workflow template shape while letting the engine skip disabled rows.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061240_labels_print_workflow_disable_redundant_steps'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.workflow_template_steps wts
SET enabled = FALSE,
    updated_at = now()
FROM public.workflow_templates wt
WHERE wt.id = wts.workflow_template_id
  AND wt.name = 'labels_print_workflow_v1'
  AND wts.operation_name IN ('generate_barcodes', 'render_labels_pdf');

SELECT pg_advisory_unlock(hashtext('202603061240_labels_print_workflow_disable_redundant_steps'));
COMMIT;
