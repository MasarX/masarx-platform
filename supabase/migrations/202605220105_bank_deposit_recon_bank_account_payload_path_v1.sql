-- Migration: bank deposit reconciliation bank-account payload path
-- Purpose:
--   Console V2 starts bank_deposit_reconciliation_v2 with the selected
--   bank_account_id in workflow context payload. The bank_statement_match
--   handler already supports metadata-driven JSON paths, so keep the workflow
--   row-driven by declaring those paths on the template and live pending steps.

SELECT pg_advisory_lock(hashtext('202605220105_bank_deposit_recon_bank_account_payload_path_v1'));

WITH target_templates AS (
  SELECT id
  FROM public.workflow_templates
  WHERE COALESCE(template_key, name) = 'bank_deposit_reconciliation_v2'
)
UPDATE public.workflow_template_steps AS step
SET metadata = COALESCE(step.metadata, '{}'::jsonb)
  || jsonb_build_object(
    'bank_account_id_path', '$.context.payload.bank_account_id',
    'bank_account_key_path', '$.context.payload.bank_account_key'
  ),
  updated_at = now()
FROM target_templates AS tpl
WHERE step.workflow_template_id = tpl.id
  AND step.operation_name = 'deposit_bank_statement_match'
  AND step.handler_key = 'bank_statement_match'
  AND (
    step.metadata->>'bank_account_id_path' IS DISTINCT FROM '$.context.payload.bank_account_id'
    OR step.metadata->>'bank_account_key_path' IS DISTINCT FROM '$.context.payload.bank_account_key'
  );

WITH target_templates AS (
  SELECT id
  FROM public.workflow_templates
  WHERE COALESCE(template_key, name) = 'bank_deposit_reconciliation_v2'
)
UPDATE public.workflow_run_steps AS run_step
SET metadata = COALESCE(run_step.metadata, '{}'::jsonb)
  || jsonb_build_object(
    'bank_account_id_path', '$.context.payload.bank_account_id',
    'bank_account_key_path', '$.context.payload.bank_account_key'
  ),
  updated_at = now()
FROM public.workflow_runs AS run
JOIN target_templates AS tpl
  ON tpl.id = run.workflow_template_id
WHERE run_step.workflow_run_id = run.id
  AND run_step.operation_name = 'deposit_bank_statement_match'
  AND run_step.handler_key = 'bank_statement_match'
  AND run_step.step_status IN ('pending', 'failed')
  AND (
    run_step.metadata->>'bank_account_id_path' IS DISTINCT FROM '$.context.payload.bank_account_id'
    OR run_step.metadata->>'bank_account_key_path' IS DISTINCT FROM '$.context.payload.bank_account_key'
  );

SELECT pg_advisory_unlock(hashtext('202605220105_bank_deposit_recon_bank_account_payload_path_v1'));
