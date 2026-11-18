-- Console V2 recipient lookup contract repair.
--
-- Recipient create/detail surfaces render lookup-backed values for phone
-- validation and communication channel. Keep those values row-driven in the
-- canonical lookup tables so live Console does not show valid recipient data as
-- unknown.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605061240_console_v2_recipient_lookup_contract_v1'));
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
  'phone_validation_status',
  'Recipient phone validation status',
  'operations',
  'tier_1',
  false
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable;

WITH rows(category, value, label, sort_order, is_default, tone) AS (
  VALUES
    ('phone_validation_status', 'valid', 'Valid', 10, false, 'good'),
    ('phone_validation_status', 'pending', 'Pending', 20, true, 'info'),
    ('phone_validation_status', 'unverified', 'Unverified', 30, false, 'warn'),
    ('phone_validation_status', 'invalid', 'Invalid', 40, false, 'danger'),
    ('communication_channel', 'sms', 'SMS', 10, false, 'info'),
    ('communication_channel', 'whatsapp', 'WhatsApp', 20, true, 'good'),
    ('communication_channel', 'email', 'Email', 30, false, 'neutral'),
    ('language_code', 'ar', 'Arabic', 10, true, 'neutral'),
    ('language_code', 'en', 'English', 20, false, 'neutral')
)
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
  d.id,
  rows.value,
  rows.label,
  rows.sort_order,
  rows.is_default,
  'active',
  jsonb_build_object('tone', rows.tone)
FROM rows
JOIN public.lookup_definitions d ON d.category = rows.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata;

SELECT pg_advisory_unlock(hashtext('202605061240_console_v2_recipient_lookup_contract_v1'));

COMMIT;
