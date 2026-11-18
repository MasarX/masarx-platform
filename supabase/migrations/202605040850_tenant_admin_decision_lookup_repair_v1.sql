-- Console V2 tenant-admin lifecycle RPCs emit append-only decision_log rows for
-- organization profile updates and tenant user invitations. Keep the lookup
-- enforced decision contract aligned with those canonical lifecycle writes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031780_tenant_admin_decision_lookup_repair_v1'));
SET search_path TO public, extensions, pg_temp;

WITH categories(value, label, sort_order) AS (
  VALUES
    ('organizations.profile_update', 'Organization Profile Update', 2340),
    ('users.invite', 'User Invite', 2350)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
)
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
  d.id,
  c.value,
  c.label,
  'Decision category emitted by canonical Console V2 tenant-admin lifecycle RPCs.',
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'tenant_admin_decision_lookup_repair_v1',
    'tone', 'info'
  )
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

WITH outcomes(value, label, sort_order, tone) AS (
  VALUES
    ('invited', 'Invited', 2090, 'good'),
    ('idempotent_existing_assignment', 'Idempotent Existing Assignment', 2100, 'info'),
    ('updated', 'Updated', 2110, 'good')
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1
)
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
  d.id,
  o.value,
  o.label,
  'Decision outcome emitted by canonical Console V2 tenant-admin lifecycle RPCs.',
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'tenant_admin_decision_lookup_repair_v1',
    'tone', o.tone
  )
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

WITH statuses(value, label, sort_order, tone) AS (
  VALUES
    ('invited', 'Invited', 15, 'info')
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'user_status'
   LIMIT 1
)
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
  d.id,
  s.value,
  s.label,
  'User lifecycle status emitted by Console V2 tenant user invitation.',
  s.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'tenant_admin_decision_lookup_repair_v1',
    'tone', s.tone
  )
FROM definition d
CROSS JOIN statuses s
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605031780_tenant_admin_decision_lookup_repair_v1'));
COMMIT;
