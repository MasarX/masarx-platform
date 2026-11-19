BEGIN;

SELECT pg_advisory_lock(hashtext('202605221430_workflow_run_cancel_action_policy_v1'));

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status, metadata)
SELECT ld.id, v.value, v.label, v.sort_order, false, 'active', v.metadata::jsonb
  FROM public.lookup_definitions ld
 CROSS JOIN (VALUES
   ('running', 'Running', 25, '{"tone":"info","allows_retry":false,"allows_abort":true,"blocks_cod_restart":true,"is_failed":false}'::text),
   ('succeeded', 'Succeeded', 35, '{"tone":"good","allows_retry":false,"allows_abort":false,"blocks_cod_restart":false,"is_failed":false}'::text),
   ('timeout', 'Timeout', 65, '{"tone":"danger","allows_retry":true,"allows_abort":false,"blocks_cod_restart":false,"is_failed":true}'::text),
   ('canceled', 'Canceled', 75, '{"tone":"neutral","allows_retry":false,"allows_abort":false,"blocks_cod_restart":false,"is_failed":false}'::text)
 ) AS v(value, label, sort_order, metadata)
 WHERE ld.category = 'workflow_run_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       sort_order = EXCLUDED.sort_order,
       status = 'active',
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now();

UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
     || jsonb_build_object(
       'allows_abort',
       lv.value IN ('pending', 'in_progress', 'running')
     ),
       updated_at = now()
  FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'workflow_run_status';

SELECT pg_advisory_unlock(hashtext('202605221430_workflow_run_cancel_action_policy_v1'));

COMMIT;
