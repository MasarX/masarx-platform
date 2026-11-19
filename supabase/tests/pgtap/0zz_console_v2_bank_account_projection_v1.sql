BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(1);

WITH account_projections AS (
  SELECT public.ui_read_projection_columns_v1(entry, 'public.bank_accounts'::regclass) AS fields
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
    CROSS JOIN LATERAL jsonb_array_elements(sv.value->'resources') AS resource(entry)
   WHERE s.category = 'ui_read_registry' AND entry->>'key' = 'bank_accounts'
)
SELECT ok(
  COALESCE(bool_and(fields @> ARRAY['id', 'iban_last4', 'account_last4']
    AND NOT fields && ARRAY['iban_sha256', 'account_sha256', 'metadata']), FALSE),
  'bank account projections show the displayed suffixes and exclude hashes and metadata'
)
FROM account_projections;

SELECT * FROM finish();
ROLLBACK;
