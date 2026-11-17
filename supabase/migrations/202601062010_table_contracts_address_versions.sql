-- Plan: PLAN-202601-address-versioned-addresses-pitch-progress / Step: S01

-- Register address_versions in table_contracts to satisfy timestamp/audit contracts.
-- address_versions is append-only history and does not have updated_at.

INSERT INTO public.table_contracts (
  id,
  table_schema,
  table_name,
  created_at_required,
  created_at_source_column,
  updated_at_required,
  updated_at_source_column,
  audit_enabled,
  notes,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000062010'::uuid,
  'public',
  'address_versions',
  TRUE,
  'created_at',
  FALSE,
  NULL,
  FALSE,
  'Append-only SSOT history for address changes; immutable by trigger; no updated_at; canonical provenance captured via decision_log/settings_resolution_log.',
  now(),
  now()
)
ON CONFLICT (table_schema, table_name) DO NOTHING;
