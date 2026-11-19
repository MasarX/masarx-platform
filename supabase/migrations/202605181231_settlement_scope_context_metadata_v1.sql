BEGIN;
SELECT pg_advisory_lock(hashtext('202605181231_settlement_scope_context_metadata_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || v.metadata::jsonb,
    updated_at = now()
FROM public.lookup_definitions ld
JOIN (
  VALUES
    (
      'driver_shift',
      '{"console_context":{"required":[{"payload_key":"subject_id","label":"Driver","resource":"drivers","value_key":"user_id","subject_type":"driver","hint":"Driver shift settlements must name the driver being settled."}]}}'::jsonb
    ),
    (
      'branch_day',
      '{"console_context":{"required":[{"payload_key":"branch_id","label":"Branch","resource":"branches","value_key":"id","hint":"Branch day settlements must name the branch being reconciled."}]}}'::jsonb
    ),
    (
      'client_cycle',
      '{"console_context":{"required":[{"payload_key":"client_id","label":"Client","resource":"clients","value_key":"id","hint":"Client cycle settlements must name the client account."}]}}'::jsonb
    ),
    (
      'marketplace_contract',
      '{"console_context":{"unsupported_message":"Marketplace contract settlement batches must be started from the owning marketplace contract workflow so the contract subject is preserved."}}'::jsonb
    )
) AS v(value, metadata)
  ON TRUE
WHERE ld.id = lv.lookup_definition_id
  AND ld.category = 'settlement_scope_type'
  AND lv.value = v.value;

SELECT pg_advisory_unlock(hashtext('202605181231_settlement_scope_context_metadata_v1'));
COMMIT;
