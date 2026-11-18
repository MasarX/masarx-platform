-- Repair bank reconciliation match lifecycle lookup metadata.
-- Console V2 filters active matches through lookup metadata, so the live
-- lookup rows must carry the lifecycle flags instead of relying on literals.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605181130_bank_recon_match_status_metadata_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'bank_recon_match_status',
  'Bank reconciliation match lifecycle status',
  'finance',
  'tier_1',
  false
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata
FROM public.lookup_definitions ld
JOIN (
  VALUES
    (
      'matched',
      'Matched',
      10,
      true,
      jsonb_build_object(
        'lifecycle', 'active',
        'is_active', true,
        'is_terminal', false
      )
    ),
    (
      'unmatched',
      'Unmatched',
      20,
      false,
      jsonb_build_object(
        'lifecycle', 'reversed',
        'is_active', false,
        'is_terminal', true
      )
    )
) AS v(value, label, sort_order, is_default, metadata)
  ON ld.category = 'bank_recon_match_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    retired_at = NULL,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605181130_bank_recon_match_status_metadata_v1'));
COMMIT;
