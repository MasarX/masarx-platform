-- 202607151152_shipment_identifier_online_index_phase_state_v1.sql
-- Append-only support schema for the post-migration online-index phase.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202607151152_shipment_identifier_online_index_phase_state_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.online_index_phase_state_v1 (
  phase_id TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  topology_fingerprint TEXT,
  catalog_fingerprint TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (phase_id, candidate_sha),
  CONSTRAINT online_index_phase_state_v1_candidate_sha_check
    CHECK (candidate_sha ~ '^[0-9a-f]{40}$')
);

ALTER TABLE public.online_index_phase_state_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.online_index_phase_state_v1 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.online_index_phase_state_v1 TO service_role;

DROP POLICY IF EXISTS online_index_phase_state_v1_service_policy
  ON public.online_index_phase_state_v1;
CREATE POLICY online_index_phase_state_v1_service_policy
  ON public.online_index_phase_state_v1
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

COMMENT ON TABLE public.online_index_phase_state_v1 IS
  'Durable same-SHA state for retryable out-of-transaction online index deployment phases; service-only.';

CREATE TABLE IF NOT EXISTS public.online_index_artifact_ownership_v1 (
  phase_id TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  index_schema TEXT NOT NULL,
  build_index_name TEXT NOT NULL,
  final_index_name TEXT NOT NULL,
  relation_oid OID NOT NULL,
  contract_hash TEXT NOT NULL,
  ownership_token TEXT NOT NULL,
  object_oid OID,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (phase_id, candidate_sha, index_schema, build_index_name),
  UNIQUE (index_schema, build_index_name),
  CONSTRAINT online_index_artifact_ownership_v1_candidate_sha_check
    CHECK (candidate_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT online_index_artifact_ownership_v1_hash_check
    CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT online_index_artifact_ownership_v1_token_check
    CHECK (ownership_token ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.online_index_artifact_ownership_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.online_index_artifact_ownership_v1 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.online_index_artifact_ownership_v1 TO service_role;

DROP POLICY IF EXISTS online_index_artifact_ownership_v1_service_policy
  ON public.online_index_artifact_ownership_v1;
CREATE POLICY online_index_artifact_ownership_v1_service_policy
  ON public.online_index_artifact_ownership_v1
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

COMMENT ON TABLE public.online_index_artifact_ownership_v1 IS
  'Per-object provenance for exact-candidate online-index temporary artifacts; only matching candidate-owned objects may be cleaned automatically.';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES
  (
    'online_index_phase_status',
    'Lifecycle state for one exact-candidate online-index phase.',
    'operations',
    'tier_1',
    FALSE
  ),
  (
    'online_index_artifact_status',
    'Lifecycle state for one exact-candidate online-index artifact.',
    'operations',
    'tier_1',
    FALSE
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  definition.id,
  candidate.value,
  candidate.label,
  candidate.description,
  candidate.sort_order,
  candidate.is_default,
  'active',
  '{}'::jsonb
FROM (
  VALUES
    ('online_index_phase_status', 'running', 'Running', 'Phase execution is active.', 10, TRUE),
    ('online_index_phase_status', 'interrupted', 'Interrupted', 'Phase execution stopped before completion.', 20, FALSE),
    ('online_index_phase_status', 'failed', 'Failed', 'Phase execution completed with failure.', 30, FALSE),
    ('online_index_phase_status', 'complete', 'Complete', 'Phase execution completed successfully.', 40, FALSE),
    ('online_index_artifact_status', 'reserved', 'Reserved', 'Artifact identity is reserved for the candidate.', 10, TRUE),
    ('online_index_artifact_status', 'deleting', 'Deleting', 'Candidate-owned artifact cleanup is active.', 20, FALSE),
    ('online_index_artifact_status', 'created', 'Created', 'Candidate-owned artifact exists.', 30, FALSE),
    ('online_index_artifact_status', 'promoted', 'Promoted', 'Artifact was promoted to its final identity.', 40, FALSE)
) AS candidate(category, value, label, description, sort_order, is_default)
JOIN public.lookup_definitions definition
  ON definition.category = candidate.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = EXCLUDED.status,
  metadata = EXCLUDED.metadata,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (
  table_schema,
  table_name,
  column_name,
  lookup_category,
  allowed_values
)
VALUES
  (
    'public',
    'online_index_phase_state_v1',
    'status',
    'online_index_phase_status',
    NULL
  ),
  (
    'public',
    'online_index_artifact_ownership_v1',
    'status',
    'online_index_artifact_status',
    NULL
  )
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET
  lookup_category = EXCLUDED.lookup_category,
  allowed_values = EXCLUDED.allowed_values;

SELECT public.apply_lookup_column_contracts('public');

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES
  (
    'public',
    'online_index_phase_state_v1',
    FALSE,
    FALSE,
    FALSE,
    'Service-only same-SHA online-index phase state.'
  ),
  (
    'public',
    'online_index_artifact_ownership_v1',
    TRUE,
    TRUE,
    FALSE,
    'Service-only ownership ledger for temporary online-index artifacts.'
  )
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');

COMMIT;
