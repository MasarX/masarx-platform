-- Complete Phase B6 catalog/identity/integration decision-log lookup coverage
-- and ensure ops_admin has the write capabilities exercised by those RPCs.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031570_b6_catalog_identity_decision_and_capability_repair_v1'));
SET search_path TO public, extensions, pg_temp;

WITH categories(value, label, sort_order) AS (
  VALUES
    ('clients.create', 'Clients Create', 1900),
    ('clients.reactivate', 'Clients Reactivate', 1910),
    ('clients.suspend', 'Clients Suspend', 1920),
    ('clients.update', 'Clients Update', 1930),
    ('integrations.revoke_credential', 'Integrations Revoke Credential', 1940),
    ('lookup_definitions.create', 'Lookup Definitions Create', 1950),
    ('lookup_values.archive', 'Lookup Values Archive', 1960),
    ('lookup_values.create', 'Lookup Values Create', 1970),
    ('lookup_values.promote', 'Lookup Values Promote', 1980),
    ('lookup_values.update', 'Lookup Values Update', 1990),
    ('mappings.promote', 'Mappings Promote', 2000),
    ('recipients.update', 'Recipients Update', 2010),
    ('senders.create', 'Senders Create', 2020),
    ('senders.reactivate', 'Senders Reactivate', 2030),
    ('senders.suspend', 'Senders Suspend', 2040),
    ('senders.update', 'Senders Update', 2050),
    ('service_levels.create', 'Service Levels Create', 2060),
    ('service_levels.update', 'Service Levels Update', 2070),
    ('service_offerings.archive', 'Service Offerings Archive', 2080),
    ('service_offerings.create', 'Service Offerings Create', 2090),
    ('service_offerings.toggle', 'Service Offerings Toggle', 2100),
    ('service_offerings.update', 'Service Offerings Update', 2110),
    ('sessions.revoke', 'Sessions Revoke', 2120),
    ('tasks.bulk_transition', 'Tasks Bulk Transition', 2130),
    ('users.force_password_reset', 'Users Force Password Reset', 2140),
    ('users.grant_role', 'Users Grant Role', 2150),
    ('users.profile_update', 'Users Profile Update', 2160),
    ('users.reactivate', 'Users Reactivate', 2170),
    ('users.revoke_role', 'Users Revoke Role', 2180),
    ('users.suspend', 'Users Suspend', 2190),
    ('webhooks.delete_rule', 'Webhooks Delete Rule', 2200),
    ('webhooks.force_status', 'Webhooks Force Status', 2210),
    ('webhooks.reorder_rule', 'Webhooks Reorder Rule', 2220),
    ('webhooks.replay', 'Webhooks Replay', 2230),
    ('webhooks.rotate_source_token', 'Webhooks Rotate Source Token', 2240),
    ('webhooks.upsert_rule', 'Webhooks Upsert Rule', 2250),
    ('webhooks.upsert_source', 'Webhooks Upsert Source', 2260),
    ('workflows.binding_register', 'Workflows Binding Register', 2270),
    ('workflows.template_status', 'Workflows Template Status', 2280)
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
  'Decision category emitted by canonical Phase B6 RPCs.',
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'b6_catalog_identity_decision_and_capability_repair_v1')
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH outcomes(value, label, sort_order) AS (
  VALUES
    ('active', 'Active', 1900),
    ('all_failed', 'All Failed', 1910),
    ('all_succeeded', 'All Succeeded', 1920),
    ('archived', 'Archived', 1930),
    ('draft', 'Draft', 1940),
    ('forced', 'Forced', 1950),
    ('inactive', 'Inactive', 1960),
    ('no_op', 'No Op', 1970),
    ('partial', 'Partial', 1980),
    ('promoted', 'Promoted', 1990),
    ('reactivated', 'Reactivated', 2000),
    ('registered', 'Registered', 2010),
    ('reordered', 'Reordered', 2020),
    ('replay_queued', 'Replay Queued', 2030),
    ('retired', 'Retired', 2040),
    ('revoked', 'Revoked', 2050),
    ('suspended', 'Suspended', 2060),
    ('token_rotated', 'Token Rotated', 2070)
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
  'Decision outcome emitted by canonical Phase B6 RPCs.',
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'b6_catalog_identity_decision_and_capability_repair_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

DO $do$
DECLARE
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_cap TEXT;
  v_role_idx INTEGER;
  v_cap_keys TEXT[] := ARRAY[]::TEXT[];
  v_target_caps TEXT[] := ARRAY[
    'agreements.write',
    'clients.write',
    'integration_plugins.write',
    'lookups.write',
    'mappings.write',
    'recipients.write',
    'senders.write',
    'tasks.write',
    'users.manage',
    'webhooks.write',
    'workflows.write'
  ];
  v_changed BOOLEAN := FALSE;
  v_existing_active_id UUID;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
BEGIN
  SELECT id, value
    INTO v_existing_active_id, v_current
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND approved_at IS NOT NULL
     AND effective_until IS NULL
   ORDER BY version DESC
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Active global access_control_policy settings version is missing';
  END IF;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
    v_caps := '[]'::jsonb;
  END IF;

  SELECT COALESCE(array_agg(cap->>'key'), ARRAY[]::TEXT[])
    INTO v_cap_keys
    FROM jsonb_array_elements(v_caps) AS cap;

  FOREACH v_cap IN ARRAY v_target_caps LOOP
    IF NOT (v_cap = ANY(v_cap_keys)) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', v_cap,
        'label', initcap(replace(replace(v_cap, '.', ' '), '_', ' ')),
        'category', split_part(v_cap, '.', 1)
      ));
      v_changed := TRUE;
    END IF;
  END LOOP;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
  IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
    v_roles := '[]'::jsonb;
  END IF;

  FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' = 'ops_admin' THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF jsonb_typeof(v_role_keys) IS DISTINCT FROM 'array' THEN
        v_role_keys := '[]'::jsonb;
      END IF;

      FOREACH v_cap IN ARRAY v_target_caps LOOP
        IF NOT (v_role_keys @> to_jsonb(v_cap)) AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
          v_role_keys := v_role_keys || to_jsonb(v_cap);
          v_changed := TRUE;
        END IF;
      END LOOP;

      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RETURN;
  END IF;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps);
  v_current := jsonb_set(v_current, '{roles}', v_roles);

  UPDATE public.settings_versions
     SET effective_until = now()
   WHERE id = v_existing_active_id;

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at
  ) VALUES (
    'access_control_policy',
    'global',
    NULL::uuid,
    v_next_version,
    v_current,
    1,
    'B6 catalog/identity/integration RPCs: repair ops_admin capability grants',
    now()
  )
  RETURNING id INTO v_new_settings_version_id;

  UPDATE public.settings
     SET settings_version_id = v_new_settings_version_id,
         cached_value = v_current,
         last_updated = now()
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605031570_b6_catalog_identity_decision_and_capability_repair_v1'));
COMMIT;
