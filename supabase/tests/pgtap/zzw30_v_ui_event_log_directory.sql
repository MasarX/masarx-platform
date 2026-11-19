-- pgTAP: public.v_ui_event_log_directory projection contract
-- Spec-Issue: W30 (paired projection views — INSIGHTS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_ui_event_log_directory',
  'public.v_ui_event_log_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_ui_event_log_directory',
  ARRAY[
    'id', 'organization_id', 'user_id', 'app',
    'event_type', 'event_context', 'event_name',
    'event_message', 'settings_resolution_id',
    'scope_type', 'scope_id', 'meta', 'digest', 'created_at',
    'path_label', 'command_label',
    'age_seconds', 'is_action', 'has_resolution', 'has_scope'
  ],
  'v_ui_event_log_directory exposes canonical + derived FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_ui_event_log_directory', 'SELECT'),
  'service_role has SELECT on v_ui_event_log_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_ui_event_log_directory', 'SELECT'),
  'anon has no SELECT on v_ui_event_log_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_ui_event_log_directory', 'SELECT'),
  'authenticated has SELECT on v_ui_event_log_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'ui_event_log'
       AND c.relkind = 'r'
  ),
  'public.ui_event_log remains a base table (SSOT preserved)'
);

-- 7) Projection: insert 3 ui_event_log rows: (a) action with event_context +
--    event_name canonical fields, (b) row using meta jsonb fallbacks for
--    path/command, (c) non-action page_view with no scope. Verify
--    path_label / command_label resolution + lifecycle booleans.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000030d001';
  v_user     UUID := '00000000-0000-0000-0000-00000030d002';
  v_evt_a    UUID := '00000000-0000-0000-0000-00000030d003';
  v_evt_b    UUID := '00000000-0000-0000-0000-00000030d004';
  v_evt_c    UUID := '00000000-0000-0000-0000-00000030d005';
  v_path_a    TEXT;
  v_cmd_a     TEXT;
  v_is_action_a BOOLEAN;
  v_age_a     BIGINT;
  v_path_b    TEXT;
  v_cmd_b     TEXT;
  v_path_c    TEXT;
  v_is_action_c BOOLEAN;
  v_has_scope_c BOOLEAN;
  v_has_resolution_a BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W30 UI Org', 'w30-u-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w30-uiuser-' || left(v_user::text, 8) || '@example.com',
    'W30 UI User', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Event A: canonical event_context + event_name; action event; with resolution.
  INSERT INTO public.ui_event_log (
    id, organization_id, user_id, app,
    event_type, event_context, event_name,
    settings_resolution_id, scope_type, meta, created_at
  )
  VALUES (
    v_evt_a, v_org, v_user, 'console-v2',
    'platform.flag.action.toggle', '/platform/flags', 'flag_toggle',
    '00000000-0000-0000-0000-00000030d999', 'tenant',
    jsonb_build_object('extra', 'meta'),
    now() - INTERVAL '30 seconds'
  )
  ON CONFLICT DO NOTHING;

  -- Event B: NO event_context / event_name; meta carries path + command.
  INSERT INTO public.ui_event_log (
    id, organization_id, user_id, app,
    event_type, meta, created_at
  )
  VALUES (
    v_evt_b, v_org, v_user, 'console-v2',
    'integrations.intake.click.row',
    jsonb_build_object('path', '/integrations/intake', 'command', 'open_inbox_drawer'),
    now() - INTERVAL '1 minute'
  )
  ON CONFLICT DO NOTHING;

  -- Event C: page_view (NOT an action), no resolution, no scope.
  INSERT INTO public.ui_event_log (
    id, organization_id, user_id, app,
    event_type, event_context, created_at
  )
  VALUES (
    v_evt_c, v_org, v_user, 'console-v2',
    'shell.nav.page_view', '/dashboard',
    now() - INTERVAL '2 minutes'
  )
  ON CONFLICT DO NOTHING;

  SELECT path_label, command_label, is_action, age_seconds, has_resolution
    INTO v_path_a, v_cmd_a, v_is_action_a, v_age_a, v_has_resolution_a
    FROM public.v_ui_event_log_directory
   WHERE id = v_evt_a;

  SELECT path_label, command_label
    INTO v_path_b, v_cmd_b
    FROM public.v_ui_event_log_directory
   WHERE id = v_evt_b;

  SELECT path_label, is_action, has_scope
    INTO v_path_c, v_is_action_c, v_has_scope_c
    FROM public.v_ui_event_log_directory
   WHERE id = v_evt_c;

  PERFORM ok(
    v_path_a = '/platform/flags'
      AND v_cmd_a = 'flag_toggle'
      AND v_is_action_a = TRUE
      AND v_age_a IS NOT NULL
      AND v_age_a >= 0
      AND v_has_resolution_a = TRUE
      AND v_path_b = '/integrations/intake'
      AND v_cmd_b = 'open_inbox_drawer'
      AND v_path_c = '/dashboard'
      AND v_is_action_c = FALSE
      AND v_has_scope_c = FALSE,
    'v_ui_event_log_directory resolves path_label/command_label via canonical fields with meta fallback + derives is_action/has_resolution/has_scope'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
