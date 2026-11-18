-- Console V2 label reprint reason lookup.
--
-- Shipment label reprint actions require an operator reason, and Console V2
-- resolves the default through the canonical lookup catalog in live mode.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605072010_console_v2_label_reprint_reason_lookup_v1'));
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
  'label_reprint_reason',
  'Label reprint reason taxonomy consumed by Console V2 label reprint flows.',
  'operations',
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
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  'operator_request',
  'Operator request',
  'Operator requested a fresh printable artifact from Console V2.',
  10,
  true,
  'active',
  jsonb_build_object('tone', 'neutral')
FROM public.lookup_definitions ld
WHERE ld.category = 'label_reprint_reason'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order,
      is_default = EXCLUDED.is_default,
      status = EXCLUDED.status,
      metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      effective_until = NULL,
      retired_at = NULL,
      updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605072010_console_v2_label_reprint_reason_lookup_v1'));

COMMIT;
